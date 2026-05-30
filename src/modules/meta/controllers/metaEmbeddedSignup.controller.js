const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { hashForLookup } = require("@shared/utils/hash");
const { encryptString } = require("@shared/utils/crypto");
const { encryptSecret } = require("@shared/utils/secretCrypto");

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

function getMetaError(err) {
  return err?.response?.data?.error || null;
}

async function exchangeEmbeddedSignupCode(req, res) {
  const workspaceId = String(req.workspace.id);
  const code = String(req.body?.code || "").trim();
  const wabaId = String(req.body?.waba_id || "").trim();
  const phoneNumberId = String(req.body?.phone_number_id || "").trim();
  if (!code) throw new HttpError(400, "Could not exchange Meta code");
  if (!wabaId) throw new HttpError(400, "Missing waba_id");
  if (!phoneNumberId) throw new HttpError(400, "Missing phone_number_id");

  const appId = String(process.env.META_APP_ID || process.env.APP_ID || "").trim();
  const appSecret = String(process.env.META_APP_SECRET || process.env.APP_SECRET || "").trim();
  if (!appId || !appSecret) throw new HttpError(500, "Meta app is not configured");

  const baseURL = graphBaseUrl();
  let businessToken = "";
  try {
    const tokenRes = await axios.get(`${baseURL}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
      timeout: 20000,
    });
    businessToken = String(tokenRes?.data?.access_token || "").trim();
    if (!businessToken) throw new Error("access_token missing");
  } catch (err) {
    throw new HttpError(400, "Could not exchange Meta code", {
      message: sanitizeMetaError(err, "Meta code exchange failed"),
    });
  }

  const client = axios.create({ baseURL, timeout: 20000 });
  const headers = { Authorization: `Bearer ${businessToken}` };
  let displayPhoneNumber = null;

  try {
    const phoneListRes = await client.get(`/${wabaId}/phone_numbers`, { headers });
    const phoneRows = Array.isArray(phoneListRes?.data?.data) ? phoneListRes.data.data : [];
    const matched = phoneRows.find((item) => String(item?.id || "") === phoneNumberId);
    if (!matched) {
      await WhatsAppCredentials.findOneAndUpdate(
        { workspaceId },
        {
          $set: {
            status: "failed",
            connectionMethod: "embedded_signup",
            webhookSubscribed: false,
            lastError: "Phone Number ID does not belong to this WABA",
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      throw new HttpError(400, "Phone Number ID does not belong to this WABA");
    }
    displayPhoneNumber = matched?.display_phone_number || null;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const metaErr = getMetaError(err);
    const permissionDenied = Number(metaErr?.code || 0) === 200;
    if (!permissionDenied) {
      throw new HttpError(400, "Phone Number ID does not belong to this WABA", {
        message: sanitizeMetaError(err, "WABA phone validation failed"),
      });
    }

    // Fallback for embedded-signup tokens where WABA phone_numbers field is restricted:
    // validate that phone_number_id exists and is accessible with the returned token.
    try {
      const phoneRes = await client.get(`/${phoneNumberId}`, {
        headers,
        params: { fields: "id,display_phone_number,verified_name" },
      });
      const fetchedId = String(phoneRes?.data?.id || "").trim();
      if (!fetchedId || fetchedId !== phoneNumberId) {
        throw new Error("Phone lookup mismatch");
      }
      displayPhoneNumber = String(phoneRes?.data?.display_phone_number || "").trim() || null;
    } catch (fallbackErr) {
      throw new HttpError(400, "Phone Number ID does not belong to this WABA", {
        message: sanitizeMetaError(fallbackErr, "Phone number validation failed"),
      });
    }
  }

  let subscribed = false;
  try {
    const subscribeRes = await client.post(`/${wabaId}/subscribed_apps`, null, { headers });
    subscribed = Boolean(subscribeRes?.data?.success);
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
        phoneNumberIdEnc: encryptString(phoneNumberId),
        businessAccountIdEnc: encryptString(wabaId),
        phoneNumberIdHash: hashForLookup(phoneNumberId),
        businessAccountIdHash: hashForLookup(wabaId),
        phoneNumberIdPlain: phoneNumberId,
        businessAccountIdPlain: wabaId,
        displayPhoneNumber,
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

  return res.json({
    success: true,
    connected: true,
    status: "active",
    waba_id_masked: mask(wabaId),
    phone_number_id_masked: mask(phoneNumberId),
    display_phone_number: displayPhoneNumber,
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

  row.status = "disconnected";
  row.isValid = false;
  row.webhookSubscribed = false;
  row.lastError = null;
  await row.save();
  return res.json({ success: true, status: "disconnected" });
}

module.exports = {
  exchangeEmbeddedSignupCode,
  getWhatsAppConnection,
  disconnectWhatsAppConnection,
};
