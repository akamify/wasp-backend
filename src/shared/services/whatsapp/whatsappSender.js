const axios = require("axios");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function authHeaders(accessToken) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

function toMetaErrorInfo(err, step, requestInfo = {}) {
  const data = err?.response?.data || null;
  const metaError = data?.error || null;

  return {
    step,
    request: requestInfo,
    axios: {
      message: err?.message || "Unknown Axios error",
      code: err?.code || null,
      status: err?.response?.status || null,
      statusText: err?.response?.statusText || null,
      method: err?.config?.method || requestInfo.method || null,
      url: err?.config?.url || requestInfo.url || null,
    },
    meta: metaError
      ? {
          message: metaError.message || null,
          type: metaError.type || null,
          code: metaError.code || null,
          error_subcode: metaError.error_subcode || null,
          fbtrace_id: metaError.fbtrace_id || null,
          error_user_title: metaError.error_user_title || null,
          error_user_msg: metaError.error_user_msg || null,
        }
      : null,
    raw: data,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function debugToken({ inputToken, graphApiVersion }) {
  const appId = process.env.APP_ID || process.env.META_APP_ID || "";
  const appSecret = process.env.APP_SECRET || process.env.META_APP_SECRET || "";
  if (!appId || !appSecret) return null;

  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 15000 });

  // App access token: app_id|app_secret (server-side only)
  const appAccessToken = `${appId}|${appSecret}`;

  try {
    const res = await client.get("/debug_token", {
      params: { input_token: inputToken, access_token: appAccessToken },
    });
    const data = res.data?.data || null;
    if (!data) return null;
    return {
      appId: maskSecret(data.app_id),
      type: data.type || null,
      application: data.application || null,
      userId: data.user_id || null,
      isValid: !!data.is_valid,
      expiresAt: data.expires_at ? new Date(Number(data.expires_at) * 1000).toISOString() : null,
      issuedAt: data.issued_at ? new Date(Number(data.issued_at) * 1000).toISOString() : null,
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
    };
  } catch (_) {
    return null;
  }
}

async function validateCredentials({
  accessToken,
  phoneNumberId,
  wabaId,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });

  const steps = [];

  // Step 1: phone number validation
  try {
    const url = `/${phoneNumberId}`;
    const res = await client.get(url, {
      params: { fields: "display_phone_number,verified_name" },
      headers: authHeaders(accessToken),
    });

    steps.push({
      step: "phone_number_lookup",
      ok: true,
      request: {
        method: "GET",
        url,
        params: { fields: "display_phone_number,verified_name" },
      },
      response: res.data,
    });
  } catch (err) {
    throw Object.assign(
      new Error("Phone number validation failed"),
      {
        metaDebug: toMetaErrorInfo(err, "phone_number_lookup", {
          method: "GET",
          url: `/${phoneNumberId}`,
          params: { fields: "display_phone_number,verified_name" },
        }),
        validationSteps: steps,
      }
    );
  }

  // Step 2: WABA access validation via supported edge
  try {
    const url = `/${wabaId}/phone_numbers`;
    const res = await client.get(url, {
      headers: authHeaders(accessToken),
    });
    const wabaPhoneNumbers = Array.isArray(res?.data?.data) ? res.data.data : [];
    const providedPhoneNumberId = String(phoneNumberId || "").trim();
    const isPhoneIdInWaba = wabaPhoneNumbers.some(
      (item) => String(item?.id || "").trim() === providedPhoneNumberId
    );

    steps.push({
      step: "waba_phone_numbers_lookup",
      ok: true,
      request: {
        method: "GET",
        url,
      },
      response: {
        ...res.data,
        phoneIds: wabaPhoneNumbers.map((item) => String(item?.id || "")).filter(Boolean),
        providedPhoneNumberId,
        isPhoneIdInWaba,
      },
    });

    if (!isPhoneIdInWaba) {
      const err = new Error("Provided phoneNumberId is not linked to the given WABA");
      err.metaDebug = {
        step: "waba_phone_numbers_match",
        request: {
          method: "GET",
          // effective endpoint becomes: https://graph.facebook.com/{version}/{wabaId}/phone_numbers
          url: `/${wabaId}/phone_numbers`,
          headers: { Authorization: "Bearer <ACCESS_TOKEN>" },
        },
        providedPhoneNumberId,
        availablePhoneNumberIds: wabaPhoneNumbers.map((item) => String(item?.id || "")).filter(Boolean),
      };
      err.validationSteps = steps;
      throw err;
    }
  } catch (err) {
    if (err?.metaDebug?.step === "waba_phone_numbers_match") {
      throw err;
    }
    throw Object.assign(
      new Error("WABA validation failed"),
      {
        metaDebug: toMetaErrorInfo(err, "waba_phone_numbers_lookup", {
          method: "GET",
          url: `/${wabaId}/phone_numbers`,
        }),
        validationSteps: steps,
      }
    );
  }

  // Step 3: message templates edge access validation
  try {
    const url = `/${wabaId}/message_templates`;
    const res = await client.get(url, {
      params: { limit: 1 },
      headers: authHeaders(accessToken),
    });

    steps.push({
      step: "waba_templates_lookup",
      ok: true,
      request: {
        method: "GET",
        url,
        params: { limit: 1 },
      },
      response: res.data,
    });
  } catch (err) {
    throw Object.assign(
      new Error("Template edge validation failed"),
      {
        metaDebug: toMetaErrorInfo(err, "waba_templates_lookup", {
          method: "GET",
          url: `/${wabaId}/message_templates`,
          params: { limit: 1 },
        }),
        validationSteps: steps,
      }
    );
  }

  // Step 4: token scope debug (best-effort; requires APP_ID/APP_SECRET in env)
  const tokenInfo = await debugToken({ inputToken: accessToken, graphApiVersion });
  steps.push({
    step: "debug_token",
    ok: !!tokenInfo?.isValid,
    request: { method: "GET", url: "/debug_token" },
    response: tokenInfo,
  });

  return { ok: true, steps };
}

async function submitTemplate({
  accessToken,
  wabaId,
  template,
  metaTemplateId,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });

  const createPayload = {
    name: template.name,
    language: template.language,
    category: template.category,
    components: template.components,
  };

  // When editing an existing template, Meta expects a different edge (template object by ID).
  // Template name/language are immutable for approved templates; only components/category/TTL can be edited.
  const editPayload = {
    category: template.category,
    components: template.components,
  };

  async function editById(id) {
    try {
      const res = await client.post(`/${id}`, editPayload, {
        headers: authHeaders(accessToken),
      });
      return res.data;
    } catch (err) {
      throw Object.assign(new Error("Meta template edit failed"), {
        metaDebug: toMetaErrorInfo(err, "edit_template", {
          method: "POST",
          url: `/${id}`,
          body: editPayload,
        }),
      });
    }
  }

  if (metaTemplateId) {
    // Don't wrap edit errors as "submit_template" errors; preserve the true step.
    return await editById(metaTemplateId);
  }

  // Meta sometimes holds a transient lock while deleting old language content (subcode 2388023).
  // Their guidance is "< 1 minute", but in practice it can take a bit longer, so we allow a wider window.
  const maxAttempts = Math.max(Number(process.env.META_TEMPLATE_SUBMIT_RETRIES || 4), 1);
  const retryDelaysMs = [20_000, 25_000, 30_000, 35_000];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await client.post(`/${wabaId}/message_templates`, createPayload, {
        headers: authHeaders(accessToken),
      });
      return res.data;
    } catch (err) {
      const subcode = err?.response?.data?.error?.error_subcode;
      const metaCode = err?.response?.data?.error?.code;

      // Meta sometimes returns: 2388023 "Message template language is being deleted" (transient).
      // Their advice is to retry in <1 minute. We'll do a couple of retries with backoff.
      if (Number(subcode) === 2388023 && attempt < maxAttempts) {
        const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
        await sleep(delay);
        continue;
      }

      // Recovery path: if template already exists for this language, try editing the existing template (by ID).
      // This typically happens when the UI "edits" a template but backend tries to "create" it again.
      if (Number(subcode) === 2388024) {
        try {
          const candidates = await fetchAllMessageTemplates({
            accessToken,
            wabaId,
            graphApiVersion,
            exactName: template.name,
          });

          const lang = String(template.language || "").trim().toLowerCase();
          const match =
            candidates.find(
              (t) =>
                String(t?.language || "").trim().toLowerCase() === lang &&
                String(t?.name || "").trim().toLowerCase() === String(template.name || "").trim().toLowerCase() &&
                t?.id
            ) || null;

          if (match?.id) {
            return await editById(String(match.id));
          }
        } catch (recoveryErr) {
          // Fall through to the original error with additional context.
          err.recovery = recoveryErr;
        }
      }

      // Permissions error: usually missing `whatsapp_business_management` scope or token not granted WABA access.
      // Attach debug_token output when available to help diagnose quickly.
      let tokenDebug = null;
      let providerError = null;
      if (Number(metaCode) === 200) {
        tokenDebug = await debugToken({ inputToken: accessToken, graphApiVersion });
        const scopes = new Set((tokenDebug?.scopes || []).map((s) => String(s)));
        if (tokenDebug?.isValid && !scopes.has("business_management")) {
          providerError =
            "Meta token is missing `business_management` permission. Regenerate the System User access token with `business_management`, `whatsapp_business_management`, and `whatsapp_business_messaging`, then save credentials again.";
        } else if (tokenDebug?.isValid && !scopes.has("whatsapp_business_management")) {
          providerError =
            "Meta token is missing `whatsapp_business_management` permission. Regenerate the System User access token with the required WhatsApp permissions, then save credentials again.";
        }
      }

      throw Object.assign(new Error("Meta template submit failed"), {
        metaDebug: toMetaErrorInfo(err, "submit_template", {
          method: "POST",
          url: `/${wabaId}/message_templates`,
          body: createPayload,
        }),
        recoveryError: err.recovery?.metaDebug || null,
        tokenDebug,
        providerError,
      });
    }
  }

  // Should be unreachable, but keeps control flow explicit.
  throw new Error("Meta template submit failed");
}

async function fetchTemplateStatus({
  accessToken,
  wabaId,
  templateName,
  metaTemplateId,
  graphApiVersion,
}) {
  const templates = await fetchAllMessageTemplates({
    accessToken,
    wabaId,
    graphApiVersion,
    exactName: templateName,
  });

  return (
    templates.find(
      (template) =>
        (metaTemplateId && String(template?.id || "") === String(metaTemplateId)) ||
        String(template?.name || "").toLowerCase() === String(templateName || "").toLowerCase()
    ) || null
  );
}

async function fetchMessageTemplatesPage({
  accessToken,
  wabaId,
  graphApiVersion,
  after,
  limit = 100,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });

  try {
    const res = await client.get(`/${wabaId}/message_templates`, {
      params: {
        fields: "name,status,category,language,components,rejected_reason",
        limit,
        ...(after ? { after } : {}),
      },
      headers: authHeaders(accessToken),
    });

    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta template list fetch failed"), {
      metaDebug: toMetaErrorInfo(err, "fetch_message_templates", {
        method: "GET",
        url: `/${wabaId}/message_templates`,
        params: {
          fields: "name,status,category,language,components,rejected_reason",
          limit,
          ...(after ? { after } : {}),
        },
      }),
    });
  }
}

async function fetchAllMessageTemplates({
  accessToken,
  wabaId,
  graphApiVersion,
  exactName,
}) {
  const items = [];
  let after;

  for (let page = 0; page < 20; page += 1) {
    const res = await fetchMessageTemplatesPage({
      accessToken,
      wabaId,
      graphApiVersion,
      after,
    });

    const data = Array.isArray(res?.data) ? res.data : [];
    items.push(...data);

    const nextAfter = res?.paging?.cursors?.after;
    if (!nextAfter || data.length === 0) {
      break;
    }

    after = nextAfter;
  }

  if (!exactName) return items;

  const target = String(exactName || "").trim().toLowerCase();
  return items.filter((item) => String(item?.name || "").trim().toLowerCase() === target);
}

async function sendTemplateMessage({
  accessToken,
  phoneNumberId,
  to,
  templateName,
  languageCode,
  components,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components?.length ? { components } : {}),
    },
  };

  try {
    const res = await client.post(`/${phoneNumberId}/messages`, payload, {
      headers: authHeaders(accessToken),
    });
    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta send message failed"), {
      metaDebug: toMetaErrorInfo(err, "send_template_message", {
        method: "POST",
        url: `/${phoneNumberId}/messages`,
        body: payload,
      }),
    });
  }
}

async function sendTextMessage({
  accessToken,
  phoneNumberId,
  to,
  text,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
  try {
    const res = await client.post(`/${phoneNumberId}/messages`, payload, {
      headers: authHeaders(accessToken),
    });
    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta send text message failed"), {
      metaDebug: toMetaErrorInfo(err, "send_text_message", {
        method: "POST",
        url: `/${phoneNumberId}/messages`,
        body: payload,
      }),
    });
  }
}

async function sendMediaMessage({
  accessToken,
  phoneNumberId,
  to,
  type,
  mediaId,
  link,
  caption,
  filename,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });

  const normalizedType = String(type || "").toLowerCase();
  if (!["image", "video", "audio", "document"].includes(normalizedType)) {
    throw new Error("Unsupported media type");
  }
  if (!mediaId && !link) {
    throw new Error("mediaId or link is required");
  }

  const media = {};
  if (mediaId) media.id = String(mediaId);
  if (link) media.link = String(link);
  if (caption && ["image", "video", "document"].includes(normalizedType)) {
    media.caption = String(caption);
  }
  if (filename && normalizedType === "document") {
    media.filename = String(filename);
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: normalizedType,
    [normalizedType]: media,
  };

  try {
    const res = await client.post(`/${phoneNumberId}/messages`, payload, {
      headers: authHeaders(accessToken),
    });
    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta send media message failed"), {
      metaDebug: toMetaErrorInfo(err, "send_media_message", {
        method: "POST",
        url: `/${phoneNumberId}/messages`,
        body: payload,
      }),
    });
  }
}

async function markMessageAsRead({
  accessToken,
  phoneNumberId,
  messageId,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });
  const payload = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  };
  try {
    const res = await client.post(`/${phoneNumberId}/messages`, payload, {
      headers: authHeaders(accessToken),
    });
    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta mark as read failed"), {
      metaDebug: toMetaErrorInfo(err, "mark_message_as_read", {
        method: "POST",
        url: `/${phoneNumberId}/messages`,
        body: payload,
      }),
    });
  }
}

async function deleteMessageTemplate({
  accessToken,
  wabaId,
  templateName,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });
  try {
    const res = await client.delete(`/${wabaId}/message_templates`, {
      params: { name: templateName },
      headers: authHeaders(accessToken),
    });
    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta template delete failed"), {
      metaDebug: toMetaErrorInfo(err, "delete_message_template", {
        method: "DELETE",
        url: `/${wabaId}/message_templates`,
        params: { name: templateName },
      }),
    });
  }
}

module.exports = {
  validateCredentials,
  submitTemplate,
  fetchTemplateStatus,
  fetchAllMessageTemplates,
  sendTemplateMessage,
  sendTextMessage,
  sendMediaMessage,
  markMessageAsRead,
  deleteMessageTemplate,
};
