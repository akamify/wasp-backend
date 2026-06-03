const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { User } = require("@infra/database/User");
const { AdminAccount } = require("@infra/database/AdminAccount");
const { canLoginStatus, getBlockedLoginMessage } = require("@shared/utils/userStatus");

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return next(new HttpError(401, "Missing or invalid Authorization header"));
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (String(payload?.role || "") === "admin") {
      const admin = await AdminAccount.findById(payload.sub).select("_id username displayName");
      if (!admin) return next(new HttpError(401, "Invalid or expired token"));
      req.user = { id: String(admin._id), role: "admin", workspaceId: null };
      return next();
    }

    const user = await User.findById(payload.sub).select("_id role status terminationState accountBlocked tokenVersion");
    if (!user) return next(new HttpError(401, "Invalid or expired token"));
    if (!canLoginStatus(user.status)) return next(new HttpError(403, getBlockedLoginMessage(user.status)));
    if (user.accountBlocked) return next(new HttpError(403, "This user is inactive"));
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

