const express = require("express");
const { HttpError } = require("@shared/utils/httpError");
const isPaymentWebhook = (path) => /^\/(?:api\/)?commerce\/webhooks\/razorpay(?:\/|$)/i.test(String(path).split("?")[0]);
function registerPaymentRawBody(app) {
  app.use(["/commerce/webhooks/razorpay", "/api/commerce/webhooks/razorpay"],
    express.raw({ type: "application/json", limit: "256kb", inflate: false }));
}
function paymentErrorBoundary(error, req, _res, next) {
  if (!/^\/(?:api\/)?commerce\/(payments|messages|notifications|webhooks\/razorpay)(?:\/|$)/i.test(String(req.originalUrl || req.url).split("?")[0]) || error instanceof HttpError)
    return next(error);
  const status = [400, 413, 415].includes(error.status) ? error.status : 503;
  next(new HttpError(status, status < 500 ? "Invalid Commerce payment request." : "Commerce payment operation failed. Check status before retrying."));
}
module.exports = { isPaymentWebhook, registerPaymentRawBody, paymentErrorBoundary };
