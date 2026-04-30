const axios = require("axios");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
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

    steps.push({
      step: "waba_phone_numbers_lookup",
      ok: true,
      request: {
        method: "GET",
        url,
      },
      response: res.data,
    });
  } catch (err) {
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

  return { ok: true, steps };
}

async function submitTemplate({
  accessToken,
  wabaId,
  template,
  graphApiVersion,
}) {
  const baseURL = graphBaseUrl(graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });

  const payload = {
    name: template.name,
    language: template.language,
    category: template.category,
    components: template.components,
  };

  try {
    const res = await client.post(`/${wabaId}/message_templates`, payload, {
      headers: authHeaders(accessToken),
    });
    return res.data;
  } catch (err) {
    throw Object.assign(new Error("Meta template submit failed"), {
      metaDebug: toMetaErrorInfo(err, "submit_template", {
        method: "POST",
        url: `/${wabaId}/message_templates`,
        body: payload,
      }),
    });
  }
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
  deleteMessageTemplate,
};
