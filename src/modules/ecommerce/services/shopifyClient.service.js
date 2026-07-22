const axios = require("axios");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const { HttpError } = require("@shared/utils/httpError");

const REQUIRED_SCOPES = Object.freeze(["read_orders", "read_products", "read_customers"]);
const WEBHOOK_TOPICS = Object.freeze(["orders/create", "orders/updated", "products/update", "customers/create", "app/uninstalled"]);

function config() {
  const apiKey = String(process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_CLIENT_ID || "").trim();
  const apiSecret = String(process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const apiVersion = String(process.env.SHOPIFY_API_VERSION || "2025-07").trim();
  const scopes = String(process.env.SHOPIFY_SCOPES || REQUIRED_SCOPES.join(","))
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return { apiKey, apiSecret, apiVersion, scopes };
}

function assertConfigured() {
  const cfg = config();
  if (!cfg.apiKey || !cfg.apiSecret) {
    throw new HttpError(503, "Shopify app credentials are not configured");
  }
  return cfg;
}

function installUrl() {
  const explicit = String(
    process.env.SHOPIFY_INSTALL_URL ||
      process.env.SHOPIFY_APP_INSTALL_URL ||
      process.env.SHOPIFY_APP_STORE_URL ||
      ""
  ).trim();
  if (explicit) return explicit;
  const handle = String(process.env.SHOPIFY_APP_HANDLE || "").trim().replace(/^\/+|\/+$/g, "");
  if (handle) return `https://apps.shopify.com/${encodeURIComponent(handle)}`;
  throw new HttpError(503, "Shopify install URL is not configured");
}

function normalizeShopDomain(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) throw new HttpError(400, "Shopify store domain is required");
  if (raw.includes("@")) throw new HttpError(400, "Shopify store domain must not contain credentials");

  if (/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
    return `${raw}.myshopify.com`;
  }

  const candidate = raw.includes("://") ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(400, "Invalid Shopify store domain");
  }
  if (parsed.protocol !== "https:") throw new HttpError(400, "Shopify store domain must use HTTPS");
  if (parsed.username || parsed.password) throw new HttpError(400, "Shopify store domain must not contain credentials");
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "admin.shopify.com") {
    const match = parsed.pathname.match(/^\/store\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (match?.[1]) return `${match[1].toLowerCase()}.myshopify.com`;
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new HttpError(400, "Enter your Shopify store handle, admin.shopify.com/store handle URL, or myshopify.com domain");
  }
  return host;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function buildAuthorizeUrl({ shopDomain, state, redirectUri }) {
  const cfg = assertConfigured();
  const params = new URLSearchParams({
    client_id: cfg.apiKey,
    scope: cfg.scopes.join(","),
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
}

function verifyCallbackHmac(query) {
  const cfg = assertConfigured();
  const hmac = String(query.hmac || "");
  if (!hmac) return false;
  const pairs = Object.entries(query)
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const expected = crypto.createHmac("sha256", cfg.apiSecret).update(message).digest("hex");
  return timingSafeEqual(expected, hmac);
}

async function exchangeCode({ shopDomain, code }) {
  const cfg = assertConfigured();
  const body = new URLSearchParams({
    client_id: cfg.apiKey,
    client_secret: cfg.apiSecret,
    code: String(code || ""),
  });
  const res = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    body.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: 256 * 1024,
    }
  );
  return {
    accessToken: String(res.data?.access_token || ""),
    grantedScopes: String(res.data?.scope || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}

function adminHeaders(accessToken) {
  return {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };
}

async function shopifyGet({ shopDomain, accessToken, path }) {
  const cfg = assertConfigured();
  const res = await axios.get(`https://${shopDomain}/admin/api/${cfg.apiVersion}${path}`, {
    headers: adminHeaders(accessToken),
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024,
  });
  return res.data;
}

async function shopifyPost({ shopDomain, accessToken, path, payload }) {
  const cfg = assertConfigured();
  const res = await axios.post(`https://${shopDomain}/admin/api/${cfg.apiVersion}${path}`, payload, {
    headers: adminHeaders(accessToken),
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024,
  });
  return res.data;
}

async function shopifyDelete({ shopDomain, accessToken, path }) {
  const cfg = assertConfigured();
  await axios.delete(`https://${shopDomain}/admin/api/${cfg.apiVersion}${path}`, {
    headers: adminHeaders(accessToken),
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 256 * 1024,
  });
}

async function fetchShop({ shopDomain, accessToken }) {
  const data = await shopifyGet({ shopDomain, accessToken, path: "/shop.json" });
  const shop = data?.shop || {};
  if (!shop?.myshopify_domain) throw new HttpError(400, "Unable to verify Shopify store identity");
  return {
    shopDomain: normalizeShopDomain(shop.myshopify_domain),
    shopName: String(shop.name || shop.myshopify_domain || shopDomain),
    shopifyShopId: String(shop.id || ""),
  };
}

function assertRequiredScopes(grantedScopes) {
  const granted = new Set((grantedScopes || []).map((scope) => String(scope).trim()));
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw new HttpError(400, `Shopify authorization is missing required scopes: ${missing.join(", ")}`);
  }
}

function webhookCallbackUrl() {
  const base = String(
    process.env.ECOMMERCE_WEBHOOK_BASE_URL ||
      process.env.API_URL ||
      process.env.BACKEND_URL ||
      process.env.APP_BASE_URL ||
      ""
  ).replace(/\/+$/, "");
  if (!base) throw new HttpError(503, "Ecommerce webhook base URL is not configured");
  return `${base}/api/ecommerce/webhooks/shopify`;
}

async function reconcileWebhooks({ shopDomain, accessToken }) {
  const address = webhookCallbackUrl();
  const existing = await shopifyGet({ shopDomain, accessToken, path: "/webhooks.json" });
  const rows = Array.isArray(existing?.webhooks) ? existing.webhooks : [];
  const webhooks = [];
  for (const topic of WEBHOOK_TOPICS) {
    const found = rows.find((row) => row.topic === topic && row.address === address);
    if (found) {
      webhooks.push({ externalWebhookId: String(found.id || ""), topic, status: "active", managedBy: "ai_wiz_chat" });
      continue;
    }
    const created = await shopifyPost({
      shopDomain,
      accessToken,
      path: "/webhooks.json",
      payload: { webhook: { topic, address, format: "json" } },
    });
    webhooks.push({
      externalWebhookId: String(created?.webhook?.id || ""),
      topic,
      status: "active",
      managedBy: "ai_wiz_chat",
    });
  }
  return webhooks;
}

async function cleanupManagedWebhooks({ shopDomain, accessToken, webhooks }) {
  for (const webhook of webhooks || []) {
    if (webhook?.managedBy !== "ai_wiz_chat" || !webhook?.externalWebhookId) continue;
    await shopifyDelete({
      shopDomain,
      accessToken,
      path: `/webhooks/${encodeURIComponent(webhook.externalWebhookId)}.json`,
    }).catch(() => {});
  }
}

function verifyWebhookHmac({ rawBody, signature }) {
  const cfg = assertConfigured();
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", cfg.apiSecret).update(rawBody).digest("base64");
  return timingSafeEqual(expected, String(signature || "").trim());
}

module.exports = {
  REQUIRED_SCOPES,
  WEBHOOK_TOPICS,
  assertRequiredScopes,
  buildAuthorizeUrl,
  cleanupManagedWebhooks,
  exchangeCode,
  fetchShop,
  installUrl,
  normalizeShopDomain,
  reconcileWebhooks,
  verifyCallbackHmac,
  verifyWebhookHmac,
};
