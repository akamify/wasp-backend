const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { User } = require("@infra/database/User");
const { AdminAccount } = require("@infra/database/AdminAccount");

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return next(new HttpError(401, "Missing or invalid Authorization header"));
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload.role === "admin") {
      const admin = await AdminAccount.findById(payload.sub).select("_id");
      if (!admin) return next(new HttpError(401, "Invalid or expired token"));
      req.user = { id: String(admin._id), role: "admin", workspaceId: "admin", tokenVersion: 0 };
      return next();
    }

    const user = await User.findById(payload.sub).select("_id role accountBlocked tokenVersion");
    if (!user) return next(new HttpError(401, "Invalid or expired token"));
    if (user.accountBlocked || String(user.status || "") === "banned") {
      return next(new HttpError(403, "Account blocked"));
    }
    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      return next(new HttpError(401, "Session expired. Please login again."));
    }
    req.user = { id: String(user._id), role: user.role, workspaceId: payload.workspaceId, tokenVersion: Number(user.tokenVersion || 0) };
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired token"));
  }
}

module.exports = { auth };

