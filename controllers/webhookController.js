const { metaWebhookVerifyToken, defaultWorkspaceId } = require("../config/env");
const { findTenantByPhoneNumberId, findTenantByWabaId } = require("../services/credentialsService");
const { Message } = require("../models/Message");
const mongoose = require("mongoose");
const { touchConversation } = require("../services/conversationService");
const { normalizePhone, touchContactFromMessage } = require("../services/contactService");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { Campaign } = require("../models/Campaign");

const WEBHOOK_DEBUG_LIMIT = 40;
const webhookDebugEvents = [];

function pushWebhookDebugEvent(event) {
  webhookDebugEvents.unshift({
    at: new Date().toISOString(),
    ...event,
  });
  if (webhookDebugEvents.length > WEBHOOK_DEBUG_LIMIT) {
    webhookDebugEvents.length = WEBHOOK_DEBUG_LIMIT;
  }
}

function asDateFromSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n * 1000);
}

function normalizeStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "sent") return "sent";
  if (s === "delivered") return "delivered";
  if (s === "read") return "read";
  if (s === "failed") return "failed";
  return "sent";
}

function parseTierLimitToNumber(tier) {
  const s = String(tier || "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("UNLIMITED")) return -1;

  const match = s.match(/TIER[_\s-]*([0-9]+)\s*(K|M)?/);
  if (!match) return null;
  let n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suffix = match[2] || "";
  if (suffix === "K") n *= 1000;
  if (suffix === "M") n *= 1000 * 1000;
  return n;
}

async function refreshCampaignFromMessage(workspaceId, messageDoc) {
  const campaignId = messageDoc?.campaignId;
  if (!campaignId || !workspaceId) return;

  const [campaign, grouped] = await Promise.all([
    Campaign.findOne({ _id: campaignId, workspaceId }).select("_id totals status"),
    Message.aggregate([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
          campaignId: new mongoose.Types.ObjectId(String(campaignId)),
          direction: "outbound",
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  if (!campaign) return;

  const byStatus = Object.fromEntries(grouped.map((row) => [String(row._id), Number(row.count || 0)]));
  const sentLike =
    Number(byStatus.accepted || 0) +
    Number(byStatus.sent || 0) +
    Number(byStatus.delivered || 0) +
    Number(byStatus.read || 0);
  const failedLike = Number(byStatus.failed || 0) + Number(byStatus.timeout_unknown || 0);
  const total = Number(campaign.totals?.total || 0);
  const queued = Math.max(total - sentLike - failedLike, 0);

  let nextStatus = String(campaign.status || "queued");
  if (queued === 0) {
    if (failedLike > 0 && sentLike === 0) nextStatus = "failed";
    else nextStatus = "completed";
  } else if (sentLike > 0 || failedLike > 0) {
    nextStatus = "running";
  } else {
    nextStatus = "queued";
  }

  await Campaign.updateOne(
    { _id: campaign._id, workspaceId },
    {
      $set: {
        status: nextStatus,
        "totals.queued": queued,
        "totals.sent": sentLike,
        "totals.failed": failedLike,
      },
    }
  );
}

async function verify(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === metaWebhookVerifyToken) {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.log("Webhook verify OK.");
    }
    return res.status(200).send(challenge);
  }
  if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
    // eslint-disable-next-line no-console
    console.warn("Webhook verify FAILED.", { mode, tokenPresent: !!token });
  }
  return res.sendStatus(403);
}

async function receive(req, res) {
  const body = req.body;
  if (!body) return res.sendStatus(400);
  pushWebhookDebugEvent({
    type: "incoming",
    object: body?.object || null,
    entries: Array.isArray(body?.entry) ? body.entry.length : 0,
  });

  const debug = String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true";
  if (debug) {
    // eslint-disable-next-line no-console
    console.log("Webhook received.", {
      object: body?.object,
      entries: Array.isArray(body?.entry) ? body.entry.length : 0,
    });
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const field = String(change?.field || "");
      const value = change?.value;

      // 1) Phone number quality updates (tier upgrades/downgrades etc.) come without metadata.phone_number_id
      if (field === "phone_number_quality_update") {
        const wabaId = entry?.id ? String(entry.id) : "";
        if (!wabaId) continue;
        const tenant = await findTenantByWabaId(wabaId);
        if (!tenant) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.warn("Webhook quality_update: tenant not found for wabaId.", wabaId);
          }
          continue;
        }
        if (!tenant) continue;

        const currentLimitRaw = value?.current_limit ?? null;
        const nextLimitRaw = value?.next_limit ?? null;

        const currentLimitStr = currentLimitRaw != null ? String(currentLimitRaw) : "";
        const currentLimitNum = Number(currentLimitRaw);
        const nextLimitNum = Number(nextLimitRaw);
        const ts = entry?.time ? asDateFromSeconds(entry.time) : new Date();

        const update = { lastLimitsUpdateAt: ts };
        if (currentLimitStr) update.messagingLimitTierCached = currentLimitStr;
        if (Number.isFinite(currentLimitNum) && currentLimitNum > 0) update.messagingLimitCurrentCached = currentLimitNum;
        if (Number.isFinite(nextLimitNum) && nextLimitNum > 0) update.messagingLimitNextCached = nextLimitNum;

        await WhatsAppCredentials.updateOne(
          { workspaceId: tenant.workspaceId },
          { $set: update }
        );

        continue;
      }

      // 1b) Newer webhooks: business_capability_update for messaging limits
      if (field === "business_capability_update") {
        const wabaId = entry?.id ? String(entry.id) : "";
        if (!wabaId) continue;
        const tenant = await findTenantByWabaId(wabaId);
        if (!tenant) continue;

        const perBusinessTier = value?.max_daily_conversations_per_business ?? null;
        const perPhone = value?.max_daily_conversations_per_phone ?? value?.max_daily_conversation_per_phone ?? null;
        const ts = entry?.time ? asDateFromSeconds(entry.time) : new Date();

        const tierStr = perBusinessTier != null ? String(perBusinessTier) : "";
        const currentNumFromTier = parseTierLimitToNumber(tierStr);
        const currentNumFromPhone = Number(perPhone);

        const update = { lastLimitsUpdateAt: ts };
        if (tierStr) update.messagingLimitTierCached = tierStr;
        if (Number.isFinite(currentNumFromTier) || currentNumFromTier === -1) {
          update.messagingLimitCurrentCached = currentNumFromTier;
        } else if (Number.isFinite(currentNumFromPhone) && currentNumFromPhone > 0) {
          update.messagingLimitCurrentCached = currentNumFromPhone;
        }

        await WhatsAppCredentials.updateOne(
          { workspaceId: tenant.workspaceId },
          { $set: update }
        );

        continue;
      }

      // 2) Message + status webhooks (canonical) - route by phone number id
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.warn("Webhook change missing metadata.phone_number_id.", { field });
        }
        continue;
      }

      let tenant = await findTenantByPhoneNumberId(phoneNumberId);
      if (!tenant) {
        const wabaIdFromEntry = entry?.id ? String(entry.id) : "";
        if (wabaIdFromEntry) {
          tenant = await findTenantByWabaId(wabaIdFromEntry);
          if (tenant) {
            pushWebhookDebugEvent({
              type: "tenant_resolved_by_waba_fallback",
              phoneNumberId: String(phoneNumberId),
              wabaId: wabaIdFromEntry,
            });
          }
        }
      }

      const resolvedWorkspaceId = tenant?.workspaceId ? String(tenant.workspaceId) : "";
      const fallbackWorkspaceId = String(defaultWorkspaceId || "");
      let workspaceIdRaw =
        mongoose.Types.ObjectId.isValid(resolvedWorkspaceId)
          ? resolvedWorkspaceId
          : mongoose.Types.ObjectId.isValid(fallbackWorkspaceId)
            ? fallbackWorkspaceId
            : "";

      // Last-resort fallback: pick the most recently validated WhatsApp connection.
      // This keeps inbound ingest alive even when tenant lookup hashes drift across envs.
      if (!workspaceIdRaw) {
        const recentCred = await WhatsAppCredentials.findOne({ isValid: true })
          .sort({ lastValidatedAt: -1, updatedAt: -1, createdAt: -1 })
          .select("workspaceId");
        const recentWorkspaceId = String(recentCred?.workspaceId || "");
        if (mongoose.Types.ObjectId.isValid(recentWorkspaceId)) {
          workspaceIdRaw = recentWorkspaceId;
          pushWebhookDebugEvent({
            type: "tenant_recent_credentials_fallback",
            phoneNumberId: String(phoneNumberId),
            workspaceId: workspaceIdRaw,
          });
        }
      }

      if (!workspaceIdRaw) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.warn("Webhook: workspace not resolved for phone_number_id.", phoneNumberId);
        }
        pushWebhookDebugEvent({
          type: "tenant_workspace_missing",
          phoneNumberId: String(phoneNumberId),
        });
        continue;
      }

      const hasValidWorkspaceId = mongoose.Types.ObjectId.isValid(workspaceIdRaw);

      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      if (statuses.length) {
        pushWebhookDebugEvent({
          type: "statuses",
          field,
          phoneNumberId: String(phoneNumberId),
          statuses: statuses.map((s) => ({
            id: s?.id || null,
            status: s?.status || null,
            recipient_id: s?.recipient_id || null,
            timestamp: s?.timestamp || null,
          })),
        });
      }
      if (debug && statuses.length) {
        // eslint-disable-next-line no-console
        console.log("Webhook statuses:", statuses.map((s) => ({ id: s?.id, status: s?.status })));
      }
      for (const s of statuses) {
        const waId = s.id;
        if (!waId) continue;

        const newStatus = normalizeStatus(s.status);
        const ts = asDateFromSeconds(s.timestamp);
        const phone = s.recipient_id ? normalizePhone(s.recipient_id) : undefined;

        const set = {
          status: newStatus,
          ...(phone ? { phone } : {}),
          ...(newStatus === "failed" && s.errors ? { error: s.errors } : {}),
        };

        if (newStatus === "sent") set["statusTimestamps.sentAt"] = ts;
        if (newStatus === "delivered") set["statusTimestamps.deliveredAt"] = ts;
        if (newStatus === "read") set["statusTimestamps.readAt"] = ts;
        if (newStatus === "failed") set["statusTimestamps.failedAt"] = ts;

        try {
          const filter = hasValidWorkspaceId
            ? { workspaceId: workspaceIdRaw, whatsappMessageId: waId }
            : { whatsappMessageId: waId };
          const update = hasValidWorkspaceId
            ? {
                $set: set,
                $setOnInsert: {
                  workspaceId: workspaceIdRaw,
                  // Keep phone only in $set to avoid Mongo conflicting update operators.
                  // When recipient_id is missing in status webhook, fallback to placeholder.
                  ...(phone ? {} : { phone: "unknown" }),
                  direction: "outbound",
                  "statusTimestamps.acceptedAt": new Date(),
                },
              }
            : { $set: set };

          const updated = await Message.findOneAndUpdate(
            filter,
            update,
            {
              upsert: hasValidWorkspaceId,
              returnDocument: "after",
              setDefaultsOnInsert: hasValidWorkspaceId,
            }
          );
          if (updated) {
            await refreshCampaignFromMessage(workspaceIdRaw, updated);
          }

          if (!hasValidWorkspaceId) {
            pushWebhookDebugEvent({
              type: "tenant_workspace_missing",
              waId,
              phoneNumberId: String(phoneNumberId),
            });
          }
        } catch (statusErr) {
          pushWebhookDebugEvent({
            type: "status_update_error",
            waId,
            workspaceId: workspaceIdRaw || null,
            error: statusErr?.message || "Failed to upsert status",
          });
          if (debug) {
            // eslint-disable-next-line no-console
            console.error("Webhook status upsert failed.", {
              waId,
              workspaceId: workspaceIdRaw || null,
              error: statusErr?.message,
            });
          }
        }
      }

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const webhookContacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const nameByWaId = new Map(
        webhookContacts
          .map((contact) => {
            const waId = normalizePhone(contact?.wa_id);
            const profileName = String(contact?.profile?.name || "").trim();
            return waId && profileName ? [waId, profileName] : null;
          })
          .filter(Boolean)
      );
      if (messages.length) {
        pushWebhookDebugEvent({
          type: "messages",
          field,
          phoneNumberId: String(phoneNumberId),
          messages: messages.map((m) => ({
            id: m?.id || null,
            from: m?.from || null,
            type: m?.type || null,
            timestamp: m?.timestamp || null,
          })),
        });
      }
      if (debug && messages.length) {
        // eslint-disable-next-line no-console
        console.log("Webhook inbound messages:", messages.map((m) => ({ id: m?.id, from: m?.from, type: m?.type })));
      }
      for (const m of messages) {
        const waId = m.id;
        const from = normalizePhone(m.from);
        if (!waId || !from) continue;

        const ts = asDateFromSeconds(m.timestamp);
        const text = m.text?.body || (m.type ? `[${m.type}]` : "");

        try {
          await Message.findOneAndUpdate(
            { workspaceId: workspaceIdRaw, whatsappMessageId: waId },
            {
              $set: {
                workspaceId: workspaceIdRaw,
                phone: from,
                direction: "inbound",
                status: "received",
                "statusTimestamps.receivedAt": ts,
                text,
              },
              $setOnInsert: { createdAt: ts },
            },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
          );

          await touchConversation({
            userId: workspaceIdRaw,
            phone: from,
            lastMessageAt: ts,
            lastInboundAt: ts,
            lastMessagePreview: text.slice(0, 160),
            incrementUnread: true,
          });
          await touchContactFromMessage({
            userId: workspaceIdRaw,
            phone: from,
            direction: "inbound",
            preview: text.slice(0, 160),
            occurredAt: ts,
            name: nameByWaId.get(from) || undefined,
          });
        } catch (messageErr) {
          pushWebhookDebugEvent({
            type: "inbound_update_error",
            waId,
            workspaceId: workspaceIdRaw || null,
            error: messageErr?.message || "Failed to upsert inbound message",
          });
          if (debug) {
            // eslint-disable-next-line no-console
            console.error("Webhook inbound upsert failed.", {
              waId,
              workspaceId: workspaceIdRaw || null,
              error: messageErr?.message,
            });
          }
        }
      }
    }
  }

  return res.sendStatus(200);
}

async function listWebhookDebugEvents(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), WEBHOOK_DEBUG_LIMIT);
  return res.json({
    success: true,
    count: Math.min(limit, webhookDebugEvents.length),
    events: webhookDebugEvents.slice(0, limit),
  });
}

module.exports = { verify, receive, listWebhookDebugEvents };
