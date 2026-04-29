const axios = require("axios");
const {
  metaGraphVersion,
  metaAppId,
  metaAppClientSecret,
  metaOAuthRedirectUrl,
  clientBaseUrl,
} = require("../config/env");
const { HttpError } = require("../utils/httpError");
const { signState, verifyState } = require("../utils/signedState");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { encryptString } = require("../utils/crypto");
const { hashForLookup } = require("../utils/hash");
const { validateCredentials } = require("../utils/whatsappSender");

function buildOAuthUrl({ workspaceId }) {
  if (!metaAppId) throw new HttpError(400, "Meta APP_ID not configured");
  if (!metaOAuthRedirectUrl) throw new HttpError(400, "META_OAUTH_REDIRECT_URL not configured");

  const state = signState({
    workspaceId: String(workspaceId),
    iat: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: metaAppId,
    redirect_uri: metaOAuthRedirectUrl,
    response_type: "code",
    scope:
      // Include at least one Facebook Login supported permission so the dialog is available,
      // then add WhatsApp/business scopes used for Cloud API onboarding.
      "public_profile,email,whatsapp_business_management,whatsapp_business_messaging,business_management",
    state,
  });

  return `https://www.facebook.com/${metaGraphVersion}/dialog/oauth?${params.toString()}`;
}

async function metaRedirect(req, res) {
  const url = buildOAuthUrl({ workspaceId: req.workspace.id });
  res.json({ success: true, url });
}

async function exchangeCodeForToken(code) {
  if (!metaAppId || !metaAppClientSecret) {
    throw new HttpError(400, "Meta APP_ID/APP_SECRET not configured");
  }
  if (!metaOAuthRedirectUrl) throw new HttpError(400, "META_OAUTH_REDIRECT_URL not configured");

  const tokenUrl = `https://graph.facebook.com/${metaGraphVersion}/oauth/access_token`;

  const shortRes = await axios.get(tokenUrl, {
    params: {
      client_id: metaAppId,
      client_secret: metaAppClientSecret,
      redirect_uri: metaOAuthRedirectUrl,
      code,
    },
    timeout: 20000,
  });

  const shortToken = shortRes.data?.access_token;
  if (!shortToken) throw new HttpError(400, "Meta OAuth token exchange failed");

  // Exchange short-lived token for long-lived token
  const longRes = await axios.get(tokenUrl, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: metaAppId,
      client_secret: metaAppClientSecret,
      fb_exchange_token: shortToken,
    },
    timeout: 20000,
  });

  return {
    shortLivedToken: shortToken,
    accessToken: longRes.data?.access_token || shortToken,
    expiresIn: longRes.data?.expires_in || null,
    tokenType: longRes.data?.token_type || null,
  };
}

async function discoverWabaAndPhone({ accessToken }) {
  const graph = axios.create({
    baseURL: `https://graph.facebook.com/${metaGraphVersion}`,
    timeout: 20000,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const phonesParams = {
    fields: "id,display_phone_number,verified_name,code_verification_status,status",
    limit: 25,
  };

  const businessesRes = await graph.get("/me/businesses", { params: { limit: 50 } });
  const businesses = Array.isArray(businessesRes.data?.data) ? businessesRes.data.data : [];
  if (businesses.length === 0) throw new HttpError(400, "No Meta business found for this user");

  const seenWabas = [];
  for (const business of businesses) {
    const businessId = business?.id;
    if (!businessId) continue;

    const wabaRes = await graph.get(`/${businessId}/owned_whatsapp_business_accounts`, {
      params: { fields: "id,name", limit: 50 },
    });

    const wabas = Array.isArray(wabaRes.data?.data) ? wabaRes.data.data : [];
    for (const waba of wabas) {
      const wabaId = waba?.id;
      if (!wabaId) continue;
      seenWabas.push({ id: wabaId, name: waba?.name || "" });

      const phonesRes = await graph.get(`/${wabaId}/phone_numbers`, { params: phonesParams });
      const phones = Array.isArray(phonesRes.data?.data) ? phonesRes.data.data : [];
      const phoneNumberId = phones[0]?.id;
      if (phoneNumberId) return { wabaId, phoneNumberId };
    }
  }

  const err = new HttpError(400, "No phone number found under any WABA");
  err.details = { wabas: seenWabas.slice(0, 25) };
  throw err;
}

async function persistWorkspaceCredentials({ workspaceId, accessToken, wabaId, phoneNumberId }) {
  const validationResult = await validateCredentials({
    accessToken,
    phoneNumberId,
    wabaId,
    graphApiVersion: metaGraphVersion,
  });

  await WhatsAppCredentials.findOneAndUpdate(
    { workspaceId },
    {
      $set: {
        accessTokenEnc: encryptString(accessToken),
        phoneNumberIdEnc: encryptString(phoneNumberId),
        businessAccountIdEnc: encryptString(wabaId),
        phoneNumberIdHash: hashForLookup(phoneNumberId),
        businessAccountIdHash: hashForLookup(wabaId),
        graphApiVersion: metaGraphVersion,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return validationResult;
}

async function metaCallback(req, res) {
  const { code, state, error, error_description } = req.query;

  const redirectToUi = (params) => {
    const url = new URL("/app/meta", clientBaseUrl);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      url.searchParams.set(k, String(v));
    });
    return res.redirect(url.toString());
  };

  const summarizeError = (err) => {
    const axiosStatus = err?.response?.status || null;
    const meta = err?.response?.data?.error || null;

    const metaDebug = err?.metaDebug || null;
    const metaDebugStatus = metaDebug?.axios?.status || null;
    const status = axiosStatus || metaDebugStatus || null;

    const step = metaDebug?.step || null;
    const metaMessage =
      metaDebug?.meta?.error_user_msg ||
      metaDebug?.meta?.message ||
      meta?.error_user_msg ||
      meta?.message ||
      null;

    return {
      status,
      step,
      details: metaMessage || err?.message || "Meta OAuth connect failed",
    };
  };

  try {
    if (error) {
      return redirectToUi({ ok: 0, error: "meta_oauth_failed", error_description });
    }
    if (!code || !state) {
      return redirectToUi({ ok: 0, error: "missing_oauth_code_state" });
    }

    const verified = verifyState(state);
    if (!verified.ok) {
      return redirectToUi({ ok: 0, error: verified.error });
    }

    const workspaceId = verified.value?.workspaceId;
    if (!workspaceId) {
      return redirectToUi({ ok: 0, error: "invalid_state_workspace_missing" });
    }

    const tokens = await exchangeCodeForToken(String(code));
    const discovery = await discoverWabaAndPhone({ accessToken: tokens.accessToken });
    await persistWorkspaceCredentials({
      workspaceId,
      accessToken: tokens.accessToken,
      wabaId: discovery.wabaId,
      phoneNumberId: discovery.phoneNumberId,
    });

    return redirectToUi({ ok: 1, connected: 1 });
  } catch (err) {
    const summary = summarizeError(err);
    return redirectToUi({
      ok: 0,
      error: "connect_failed",
      ...(summary.status ? { status: summary.status } : {}),
      ...(summary.step ? { step: summary.step } : {}),
      details: summary.details,
    });
  }
}

module.exports = { metaRedirect, metaCallback };
