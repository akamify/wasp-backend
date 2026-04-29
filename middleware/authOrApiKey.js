const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config/env");
const { HttpError } = require("../utils/httpError");
const { sha256Hex } = require("../utils/hash");
const { User } = require("../models/User");

async function authOrApiKey(req, res, next) {
  const header = req.headers.authorization || "";
  const apiKey = req.headers["x-api-key"];

  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    try {
      const payload = jwt.verify(token, jwtSecret);
      req.user = { id: payload.sub, role: payload.role };
      return next();
    } catch {
      return next(new HttpError(401, "Invalid or expired token"));
    }
  }

  if (apiKey) {
    const apiKeyHash = sha256Hex(apiKey);
    const user = await User.findOne({ apiKeyHash }).select("_id role");
    if (!user) return next(new HttpError(401, "Invalid API key"));
    req.user = { id: String(user._id), role: user.role };
    return next();
  }

  return next(new HttpError(401, "Missing Authorization or X-API-Key header"));
}

module.exports = { authOrApiKey };

