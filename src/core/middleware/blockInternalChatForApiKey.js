const { HttpError } = require("@shared/utils/httpError");

function blockInternalChatForApiKey(req, res, next) {
  if (req.auth?.isApiKey) {
    return next(new HttpError(403, "Use /external/chat endpoints for API key chat access."));
  }
  return next();
}

module.exports = { blockInternalChatForApiKey };
