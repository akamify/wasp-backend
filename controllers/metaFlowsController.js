const axios = require("axios");
const { HttpError } = require("../utils/httpError");
const { getCredentialsForUser } = require("../services/credentialsService");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

async function listFlows(req, res) {
  res.set("Cache-Control", "no-store");
  const creds = await getCredentialsForUser(req.workspace.id);

  const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 20000 });
  try {
    const resp = await client.get(`/${creds.wabaId}/flows`, {
      params: {
        fields: "id,name,status,categories,updated_time",
        limit: Math.min(Number(req.query.limit || 100) || 100, 200),
      },
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });

    res.json({ success: true, data: Array.isArray(resp.data?.data) ? resp.data.data : [] });
  } catch (err) {
    const message =
      err?.response?.data?.error?.message || err?.message || "Failed to fetch flows from Meta";
    throw new HttpError(400, "Meta flows fetch failed", {
      providerError: message,
      raw: err?.response?.data || null,
    });
  }
}

async function createFlow(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const name = String(req.body?.name || "").trim();
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : ["OTHER"];

  if (!name) throw new HttpError(400, "Flow name is required");

  const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 20000 });

  const form = new URLSearchParams();
  form.set("name", name);
  form.set("categories", JSON.stringify(categories));

  try {
    const resp = await client.post(`/${creds.wabaId}/flows`, form.toString(), {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    res.status(201).json({ success: true, flow: resp.data });
  } catch (err) {
    const message =
      err?.response?.data?.error?.message || err?.message || "Failed to create flow on Meta";
    throw new HttpError(400, "Meta flow create failed", {
      providerError: message,
      raw: err?.response?.data || null,
    });
  }
}

module.exports = { listFlows, createFlow };

