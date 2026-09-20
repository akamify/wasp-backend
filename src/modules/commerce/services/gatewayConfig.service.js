const { HttpError } = require("@shared/utils/httpError");
const gatewayEnabled = () => process.env.COMMERCE_GATEWAY_ENABLED === "true";
const oauthEnabled = () => gatewayEnabled() && process.env.COMMERCE_RAZORPAY_OAUTH_ENABLED === "true";
function oauthConfig(environment) {
  if (!["test", "live"].includes(environment) || !oauthEnabled()) throw new HttpError(503, "Commerce OAuth is not enabled.");
  const prefix = `COMMERCE_RAZORPAY_OAUTH_${environment.toUpperCase()}_`;
  const clientId = process.env[`${prefix}CLIENT_ID`];
  const clientSecret = process.env[`${prefix}CLIENT_SECRET`];
  const redirectUri = process.env[`${prefix}REDIRECT_URI`];
  try {
    const url = new URL(redirectUri);
    if (!clientId || !clientSecret || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || !/^\/(api\/)?commerce\/gateways\/oauth\/callback$/.test(url.pathname)) throw new Error();
  } catch { throw new HttpError(503, "Commerce OAuth configuration is incomplete."); }
  return { clientId, clientSecret, redirectUri };
}
function webhookConfig(environment, now = new Date()) {
  const config = oauthConfig(environment);
  const prefix = `COMMERCE_RAZORPAY_OAUTH_${environment.toUpperCase()}_`;
  const current = process.env[`${prefix}WEBHOOK_SECRET`];
  if (!current || current.length < 16) throw new HttpError(503, "Commerce OAuth webhook is not configured.");
  const previous = process.env[`${prefix}PREVIOUS_WEBHOOK_SECRET`];
  const until = Date.parse(process.env[`${prefix}PREVIOUS_WEBHOOK_SECRET_EXPIRES_AT`] || "");
  return { ...config, secrets: [current, ...(previous && until > now.getTime() ? [previous] : [])] };
}
module.exports = { gatewayEnabled, oauthEnabled, oauthConfig, webhookConfig };
