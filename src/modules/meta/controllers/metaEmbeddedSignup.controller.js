const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { hashForLookup } = require("@shared/utils/hash");
const { encryptString } = require("@shared/utils/crypto");
const { encryptSecret } = require("@shared/utils/secretCrypto");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");

function graphBaseUrl() {
  const version = process.env.META_GRAPH_VERSION || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

function sanitizeMetaError(err, fallback) {
  return (
    err?.response?.data?.error?.error_user_msg ||
    err?.response?.data?.error?.message ||
    err?.message ||
    fallback
  );
}

function mask(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

function maskId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function maskPhone(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function logGraphCall({ operation, path, wabaId, phoneNumberId }) {
  if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() !== "true") return;
  // eslint-disable-next-line no-console
  console.info("[embedded-signup] graph call", {
    operation,
    path,
    wabaId: maskId(wabaId),
    phoneNumberId: maskId(phoneNumberId),
  });
}

async function exchangeEmbeddedSignupCode(req, res) {
  const workspaceId = String(req.workspace.id);
  const code = String(req.body?.code || "").trim();
  const wabaId = String(req.body?.waba_id || "").trim();
  const phoneNumberId = String(req.body?.phone_number_id || "").trim();
  const missing = {
    code: !code,
    waba_id: !wabaId,
    phone_number_id: !phoneNumberId,
  };
  if (missing.code || missing.waba_id || missing.phone_number_id) {
    return res.status(400).json({
      success: false,
      message: "Embedded signup details missing. Please complete signup popup flow.",
      missing,
    });
  }

  const debug = String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true";
  if (debug) {
    // eslint-disable-next-line no-console
    console.info("[embedded-signup] exchange request", {
      workspaceIdPresent: !!workspaceId,
      wabaId: maskId(wabaId),
      phoneNumberId: maskId(phoneNumberId),
      hasCode: !!code,
      hasWabaId: !!wabaId,
      hasPhoneNumberId: !!phoneNumberId,
    });
  }

  let appId = "";
  let appSecret = "";
  try {
    const cfg = getMetaAppConfig();
    appId = cfg.metaAppId;
    appSecret = cfg.metaAppSecret;
  } catch {
    throw new HttpError(500, "Meta app is not configured");
  }

  const baseURL = graphBaseUrl();
  let businessToken = "";
  try {
    logGraphCall({
      operation: "exchange_code",
      path: "/oauth/access_token",
      wabaId,
      phoneNumberId,
    });
    const tokenRes = await axios.get(`${baseURL}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
      timeout: 20000,
    });
    businessToken = String(tokenRes?.data?.access_token || "").trim();
    if (!businessToken) throw new Error("access_token missing");
    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[embedded-signup] code exchange success", { hasToken: !!businessToken });
    }
  } catch (err) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.warn("[embedded-signup] code exchange failed", { reason: sanitizeMetaError(err, "Meta code exchange failed") });
    }
    throw new HttpError(400, "Could not exchange Meta code", {
      message: sanitizeMetaError(err, "Meta code exchange failed"),
    });
  }

  const client = axios.create({ baseURL, timeout: 20000 });
  const headers = { Authorization: `Bearer ${businessToken}` };
  let validatedPhoneNumber = null;

  try {
    let phoneRows = [];
    try {
      logGraphCall({
        operation: "list_waba_phone_numbers_minimal_fields",
        path: `/${wabaId}/phone_numbers?fields=id,display_phone_number`,
        wabaId,
        phoneNumberId,
      });
      const phoneListRes = await client.get(`/${wabaId}/phone_numbers`, {
        headers,
        params: { fields: "id,display_phone_number" },
      });
      phoneRows = Array.isArray(phoneListRes?.data?.data) ? phoneListRes.data.data : [];
      if (debug) {
        // eslint-disable-next-line no-console
        console.info("[embedded-signup] minimal phone list success", { count: phoneRows.length });
      }
    } catch (minimalErr) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn("[embedded-signup] minimal phone list failed", {
          reason: sanitizeMetaError(minimalErr, "phone list minimal fields failed"),
        });
      }
      const metaCode = Number(minimalErr?.response?.data?.error?.code || 0);
      if (metaCode !== 200) throw minimalErr;

      // Retry once without fields for restrictive permission cases.
      logGraphCall({
        operation: "list_waba_phone_numbers_no_fields_fallback",
        path: `/${wabaId}/phone_numbers`,
        wabaId,
        phoneNumberId,
      });
      const fallbackRes = await client.get(`/${wabaId}/phone_numbers`, { headers });
      phoneRows = Array.isArray(fallbackRes?.data?.data) ? fallbackRes.data.data : [];
      if (debug) {
        // eslint-disable-next-line no-console
        console.info("[embedded-signup] no-fields fallback success", { count: phoneRows.length });
      }
    }

    const matched = phoneRows.find((item) => String(item?.id || "").trim() === phoneNumberId);

    if (matched) {
      validatedPhoneNumber = matched;
    } else if (phoneRows.length === 1) {
      validatedPhoneNumber = phoneRows[0];
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn("[embedded-signup] Provided phone_number_id mismatch; using only returned WABA phone number", {
          providedPhoneNumberId: maskId(phoneNumberId),
          resolvedPhoneNumberId: maskId(validatedPhoneNumber?.id),
        });
      }
    } else {
      await WhatsAppCredentials.findOneAndUpdate(
        { workspaceId },
        {
          $set: {
            status: "failed",
            connectionMethod: "embedded_signup",
            webhookSubscribed: false,
            lastError: "Selected phone number could not be matched to the selected WABA. Please reconnect WhatsApp and select the correct phone number.",
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      throw new HttpError(400, "Selected phone number could not be matched to the selected WABA. Please reconnect WhatsApp and select the correct phone number.");
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[embedded-signup] phone_numbers fetched", {
        count: phoneRows.length,
        returned: phoneRows.map((item) => ({
          id: maskId(item?.id),
          display_phone_number: maskPhone(item?.display_phone_number),
        })),
        matchedProvided: !!matched,
      });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Could not read phone numbers from the connected WABA. Please make sure the embedded signup configuration includes WhatsApp Business Management access and try again.", {
      message: sanitizeMetaError(err, "WABA phone read failed"),
    });
  }

  let subscribed = false;
  try {
    logGraphCall({
      operation: "subscribe_waba_webhook",
      path: `/${wabaId}/subscribed_apps`,
      wabaId,
      phoneNumberId: String(validatedPhoneNumber?.id || phoneNumberId),
    });
    const subscribeRes = await client.post(`/${wabaId}/subscribed_apps`, null, { headers });
    subscribed = Boolean(subscribeRes?.data?.success);
    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[embedded-signup] subscribed_apps result", { subscribed });
    }
  } catch (err) {
    await WhatsAppCredentials.findOneAndUpdate(
      { workspaceId },
      {
        $set: {
          status: "failed",
          connectionMethod: "embedded_signup",
          webhookSubscribed: false,
          lastError: "Could not subscribe WABA to webhook",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    throw new HttpError(400, "Could not subscribe WABA to webhook", {
      message: sanitizeMetaError(err, "WABA webhook subscription failed"),
    });
  }

  const now = new Date();
  await WhatsAppCredentials.findOneAndUpdate(
    { workspaceId },
    {
      $set: {
        accessTokenEnc: encryptString(businessToken),
        businessTokenEnc: encryptSecret(businessToken),
        phoneNumberIdEnc: encryptString(String(validatedPhoneNumber?.id || phoneNumberId)),
        businessAccountIdEnc: encryptString(wabaId),
        phoneNumberIdHash: hashForLookup(String(validatedPhoneNumber?.id || phoneNumberId)),
        businessAccountIdHash: hashForLookup(wabaId),
        phoneNumberIdPlain: String(validatedPhoneNumber?.id || phoneNumberId),
        businessAccountIdPlain: wabaId,
        displayPhoneNumber: String(validatedPhoneNumber?.display_phone_number || "").trim() || null,
        graphApiVersion: process.env.META_GRAPH_VERSION || "v25.0",
        isValid: true,
        status: "active",
        webhookSubscribed: subscribed,
        connectionMethod: "embedded_signup",
        lastError: null,
        lastValidatedAt: now,
        connectedAt: now,
        lastEditedAt: now,
        lastEditedBy: req.user?.id || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (debug) {
    // eslint-disable-next-line no-console
    console.info("[embedded-signup] connection active", {
      hasWabaId: !!wabaId,
      hasPhoneNumberId: !!phoneNumberId,
      webhookSubscribed: subscribed,
    });
  }
  return res.json({
    success: true,
    connected: true,
    status: "active",
    waba_id_masked: mask(wabaId),
    phone_number_id_masked: mask(String(validatedPhoneNumber?.id || phoneNumberId)),
    display_phone_number: String(validatedPhoneNumber?.display_phone_number || "").trim() || null,
    webhook_subscribed: subscribed,
  });
}

async function getWhatsAppConnection(req, res) {
  const row = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberIdPlain businessAccountIdPlain isValid"
  );
  if (!row) {
    return res.json({
      connected: false,
      status: "disconnected",
      waba_id: null,
      phone_number_id: null,
      waba_id_masked: null,
      phone_number_id_masked: null,
      display_phone_number: null,
      webhook_subscribed: false,
      connected_at: null,
      last_error: null,
    });
  }
  return res.json({
    connected: row.isValid && row.status === "active",
    status: row.status || (row.isValid ? "active" : "pending"),
    waba_id: row.businessAccountIdPlain || null,
    phone_number_id: row.phoneNumberIdPlain || null,
    waba_id_masked: mask(row.businessAccountIdPlain),
    phone_number_id_masked: mask(row.phoneNumberIdPlain),
    display_phone_number: row.displayPhoneNumber || null,
    webhook_subscribed: Boolean(row.webhookSubscribed),
    connected_at: row.connectedAt || null,
    last_error: row.lastError || null,
  });
}

async function disconnectWhatsAppConnection(req, res) {
  const row = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "+accessTokenEnc +businessAccountIdEnc status"
  );
  if (!row) return res.json({ success: true, status: "disconnected" });

  try {
    const token = row.accessTokenEnc ? require("@shared/utils/crypto").decryptString(row.accessTokenEnc) : "";
    const wabaId = row.businessAccountIdEnc ? require("@shared/utils/crypto").decryptString(row.businessAccountIdEnc) : "";
    if (token && wabaId) {
      const baseURL = graphBaseUrl();
      await axios.delete(`${baseURL}/${wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12000,
      }).catch(() => null);
    }
  } catch {}

  await WhatsAppCredentials.deleteOne({ _id: row._id });
  return res.json({ success: true, status: "disconnected" });
}

module.exports = {
  exchangeEmbeddedSignupCode,
  getWhatsAppConnection,
  disconnectWhatsAppConnection,
};
