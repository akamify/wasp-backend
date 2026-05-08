const { HttpError } = require("../utils/httpError");
const { sha256Hex } = require("../utils/hash");
const { User } = require("../models/User");

async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") {
    return next(new HttpError(401, "Missing X-API-Key header"));
  }

  const apiKeyHash = sha256Hex(apiKey);
  const user = await User.findOne({ apiKeyHash }).select("_id role");
  if (!user) return next(new HttpError(401, "Invalid API key"));

  req.user = { id: String(user._id), role: user.role };
  return next();
}

module.exports = { apiKeyAuth };

