const { HttpError } = require("@shared/utils/httpError");
function orderErrorBoundary(error, req, _res, next) {
  if (!/^\/(?:api\/)?commerce\/(orders|fulfillment)(?:\/|$)/i.test(String(req.originalUrl || req.url).split("?")[0]) || error instanceof HttpError)
    return next(error);
  // Parser errors can contain address snippets; sanitize errors originating before router middleware.
  const status = [400, 413, 415].includes(error.status) ? error.status : 503;
  next(new HttpError(status, status < 500 ? "Invalid Commerce order request." : "Commerce order operation failed. Check status before retrying."));
}
module.exports = { orderErrorBoundary };
