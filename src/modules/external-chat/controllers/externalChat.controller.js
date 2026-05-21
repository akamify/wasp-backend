const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { Conversation } = require("@infra/database/Conversation");
const { Message } = require("@infra/database/Message");
const { assertNormalizedPhone, normalizePhone } = require("@shared/services/contactService");
const { markConversationRead } = require("@shared/services/conversationService");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { markMessageAsRead } = require("@shared/utils/whatsappSender");
const { sendTextMessageForUser, sendMediaMessageForUser } = require("@shared/services/outboundMessageService");
const { isCustomerServiceWindowOpen } = require("@shared/services/pricingService");
const { subscribeWorkspaceEvents } = require("@shared/services/realtimeService");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { jwtSecret } = require("@core/config/env");
const { toExternalConversationDto } = require("@modules/external-chat/dto/externalConversation.dto");
const { toExternalMessageDto } = require("@modules/external-chat/dto/externalMessage.dto");
const { externalReadyPayload, externalPingPayload } = require("@modules/external-chat/dto/externalRealtime.dto");
const { resolveExternalChatAccessState } = require("@modules/external-chat/services/externalChatAccess.service");
const { mapExternalRealtimeEvent } = require("@modules/external-chat/services/externalRealtimeMap.service");

function ok(res, message, data) {
  return res.json({ success: true, message, data: data || {} });
}

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

async function listConversations(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const conversations = await Conversation.find({ workspaceId: req.workspace.id }).sort({ lastMessageAt: -1 }).limit(limit);
  return ok(res, "CONVERSATIONS_LISTED", {
    items: conversations.map(toExternalConversationDto),
    pagination: {
      limit,
      total: conversations.length,
      hasNextPage: conversations.length >= limit,
    },
  });
}

async function listConversationMessages(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number", { code: "INVALID_PHONE" });

  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const messages = await Message.find({ workspaceId: req.workspace.id, phone }).sort({ createdAt: -1 }).limit(limit);

  return ok(res, "CONVERSATION_MESSAGES_LISTED", {
    phone,
    items: messages.slice().reverse().map(toExternalMessageDto),
  });
}

async function readConversation(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number", { code: "INVALID_PHONE" });

  try {
    const creds = await getCredentialsForUser(req.workspace.id);
    const pendingInbound = await Message.find({
      workspaceId: req.workspace.id,
      phone,
      direction: "inbound",
      status: "received",
      whatsappMessageId: { $type: "string" },
      readReceiptSentAt: null,
    })
      .sort({ createdAt: 1 })
      .limit(100)
      .select("_id whatsappMessageId");

    for (const msg of pendingInbound) {
      try {
        await markMessageAsRead({
          accessToken: creds.accessToken,
          phoneNumberId: creds.phoneNumberId,
          messageId: String(msg.whatsappMessageId),
          graphApiVersion: creds.graphApiVersion,
        });
        await Message.updateOne(
          { _id: msg._id },
          {
            $set: {
              readReceiptSentAt: new Date(),
              "statusTimestamps.readByBusinessAt": new Date(),
            },
          }
        );
      } catch {
        // Best-effort only.
      }
    }
  } catch {
    // Best-effort only.
  }

  const conversation = await markConversationRead({ userId: req.workspace.id, phone });
  return ok(res, "CONVERSATION_MARKED_READ", {
    phone,
    conversation: toExternalConversationDto(conversation) || null,
  });
}

async function uploadMedia(req, res) {
  const file = req.file;
  if (!file) throw new HttpError(400, "File is required", { code: "FILE_REQUIRED" });

  const creds = await getCredentialsForUser(req.workspace.id);
  const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 30000 });

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  const safeName = `${crypto.randomUUID()}${file.mimetype === "application/pdf" ? ".pdf" : ""}`;
  form.append("file", file.buffer, { filename: safeName, contentType: file.mimetype });

  try {
    const uploadRes = await client.post(`/${creds.phoneNumberId}/media`, form, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const mediaId = uploadRes.data?.id ? String(uploadRes.data.id) : null;
    if (!mediaId) throw new Error("No media id returned by Meta");

    await writeAuditLog(req, {
      action: "external_chat.media_uploaded",
      resourceType: "external_chat",
      resourceId: req.auth?.apiKeyId || req.workspace.id,
      metadata: {
        workspaceId: req.workspace.id,
        apiKeyId: req.auth?.apiKeyId || null,
      },
    });

    return ok(res, "MEDIA_UPLOADED", { mediaId });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta media upload failed";
    throw new HttpError(400, "Message media upload failed", { code: "MEDIA_UPLOAD_FAILED", providerError: msg });
  }
}

function closedWindowError() {
  return new HttpError(409, "Customer service window is closed. Template message is required.", {
    code: "CUSTOMER_SERVICE_WINDOW_CLOSED",
  });
}

async function sendText(req, res) {
  const normalizedPhone = assertNormalizedPhone(req.body.to);
  const text = String(req.body.text || "").trim();
  if (!text) throw new HttpError(400, "Text is required", { code: "TEXT_REQUIRED" });

  const windowOpen = await isCustomerServiceWindowOpen({ workspaceId: req.workspace.id, phone: normalizedPhone });
  if (!windowOpen) throw closedWindowError();

  try {
    const result = await sendTextMessageForUser({
      userId: req.workspace.id,
      to: normalizedPhone,
      text,
      sentBy: { kind: "api" },
    });

    await writeAuditLog(req, {
      action: "external_chat.message_sent",
      resourceType: "external_chat",
      resourceId: result?.message?._id ? String(result.message._id) : req.auth?.apiKeyId,
      metadata: {
        workspaceId: req.workspace.id,
        apiKeyId: req.auth?.apiKeyId || null,
        phone: normalizedPhone,
        messageId: result?.message?._id ? String(result.message._id) : null,
      },
    });

    return ok(res, "MESSAGE_SENT", {
      message: toExternalMessageDto(result.message),
    });
  } catch (err) {
    if (err?.statusCode) throw err;
    throw new HttpError(err?.response?.status || 502, "Failed to send text message", { code: "TEXT_SEND_FAILED" });
  }
}

async function sendMedia(req, res) {
  const normalizedPhone = assertNormalizedPhone(req.body.to);

  const windowOpen = await isCustomerServiceWindowOpen({ workspaceId: req.workspace.id, phone: normalizedPhone });
  if (!windowOpen) throw closedWindowError();

  try {
    const result = await sendMediaMessageForUser({
      userId: req.workspace.id,
      to: normalizedPhone,
      type: req.body.type,
      mediaId: req.body.mediaId,
      link: req.body.link,
      caption: req.body.caption,
      filename: req.body.filename,
      sentBy: { kind: "api" },
    });

    await writeAuditLog(req, {
      action: "external_chat.media_sent",
      resourceType: "external_chat",
      resourceId: result?.message?._id ? String(result.message._id) : req.auth?.apiKeyId,
      metadata: {
        workspaceId: req.workspace.id,
        apiKeyId: req.auth?.apiKeyId || null,
        phone: normalizedPhone,
        messageId: result?.message?._id ? String(result.message._id) : null,
      },
    });

    return ok(res, "MEDIA_SENT", {
      message: toExternalMessageDto(result.message),
    });
  } catch (err) {
    if (err?.statusCode) throw err;
    throw new HttpError(err?.response?.status || 502, "Failed to send media message", { code: "MEDIA_SEND_FAILED" });
  }
}

async function issueRealtimeToken(req, res) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 5 * 60;
  const payload = {
    typ: "external_chat_stream",
    jti: randomUUID(),
    sub: req.user.id,
    workspaceId: req.workspace.id,
    apiKeyId: req.auth.apiKeyId,
    iat: nowSec,
    exp: expSec,
  };

  const token = jwt.sign(payload, jwtSecret);

  await writeAuditLog(req, {
    action: "external_chat.stream_token_issued",
    resourceType: "external_chat",
    resourceId: req.auth.apiKeyId,
    metadata: {
      workspaceId: req.workspace.id,
      apiKeyId: req.auth.apiKeyId,
      jti: payload.jti,
    },
  });

  return ok(res, "STREAM_TOKEN_ISSUED", {
    token,
    expiresAt: new Date(expSec * 1000).toISOString(),
  });
}

function writeSseEvent(res, eventType, payload) {
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamRealtime(req, res, next) {
  const token = String(req.query.token || "").trim();
  if (!token) return next(new HttpError(401, "Missing token", { code: "MISSING_STREAM_TOKEN" }));

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    return next(new HttpError(401, "Invalid or expired token", { code: "INVALID_STREAM_TOKEN" }));
  }

  if (payload?.typ !== "external_chat_stream") {
    return next(new HttpError(401, "Invalid stream token type", { code: "INVALID_STREAM_TOKEN_TYPE" }));
  }
  if (!payload?.jti || !payload?.sub || !payload?.workspaceId || !payload?.apiKeyId) {
    return next(new HttpError(401, "Invalid stream token payload", { code: "INVALID_STREAM_TOKEN_PAYLOAD" }));
  }

  const state = await resolveExternalChatAccessState({
    userId: String(payload.sub),
    apiKeyId: String(payload.apiKeyId),
    workspaceId: String(payload.workspaceId),
  });

  if (!state.allowed) {
    return next(new HttpError(403, "Stream access denied", { code: "STREAM_ACCESS_DENIED" }));
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  writeSseEvent(res, "connection.ready", externalReadyPayload());

  const workspaceId = String(payload.workspaceId);
  const pingTimer = setInterval(() => {
    writeSseEvent(res, "connection.ping", externalPingPayload());
  }, 25000);

  const revokeCheckTimer = setInterval(async () => {
    try {
      const accessState = await resolveExternalChatAccessState({
        userId: String(payload.sub),
        apiKeyId: String(payload.apiKeyId),
        workspaceId,
      });
      if (!accessState.allowed) {
        writeSseEvent(res, "auth.revoked", { reason: accessState.reason });
        cleanup();
      }
    } catch {
      writeSseEvent(res, "auth.revoked", { reason: "state_check_failed" });
      cleanup();
    }
  }, 30000);

  const unsubscribe = subscribeWorkspaceEvents(workspaceId, async (event) => {
    try {
      const mapped = await mapExternalRealtimeEvent(workspaceId, event);
      if (!mapped) return;
      writeSseEvent(res, mapped.type, mapped.data);
    } catch {
      // Never crash stream for mapping issues.
    }
  });

  function cleanup() {
    clearInterval(pingTimer);
    clearInterval(revokeCheckTimer);
    unsubscribe();
    res.end();
  }

  req.on("close", cleanup);
}

module.exports = {
  listConversations,
  listConversationMessages,
  readConversation,
  uploadMedia,
  sendText,
  sendMedia,
  issueRealtimeToken,
  streamRealtime,
};
