const isGatewayOAuthCallback = (url) => /^\/(?:api\/)?commerce\/gateways\/oauth\/callback\/?$/i.test(String(url || "").split("?")[0]);
const isGatewayOAuthWebhook = (url) => /^\/(?:api\/)?commerce\/gateways\/oauth\/webhooks\/[^/]+\/?$/i.test(String(url || "").split("?")[0]);
const { HttpError } = require("@shared/utils/httpError");
function gatewayErrorBoundary(error, req, _res, next) {
  if (!/^\/(?:api\/)?commerce\/gateways(?:\/|$)/i.test(String(req.originalUrl || req.url).split("?")[0]) || error instanceof HttpError)
    return next(error);
  // Body-parser syntax errors may quote plaintext credentials. They occur before router middleware.
  const status = [400, 413, 415].includes(error.status) ? error.status : 503;
  next(new HttpError(status, status < 500 ? "Invalid Commerce gateway request." : "Commerce gateway operation failed. Check status before retrying."));
}
module.exports = { isGatewayOAuthCallback, isGatewayOAuthWebhook, gatewayErrorBoundary };
