const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { User } = require("@infra/database/User");
const { AdminAccount } = require("@infra/database/AdminAccount");
const { AuthSession } = require("@infra/database/AuthSession");
const { readAuthCookies } = require("@modules/auth/auth.cookie");
const { canLoginStatus, getBlockedLoginMessage } = require("@shared/utils/userStatus");

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const tokenFromCookie = readAuthCookies(req).accessToken;
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : String(tokenFromCookie || "").trim();
  if (!token) {
    return next(new HttpError(401, "Missing or invalid Authorization header"));
  }
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (String(payload?.accountType || "") === "admin_account") {
      const admin = await AdminAccount.findById(payload.sub).select("_id username displayName");
      if (!admin) return next(new HttpError(401, "Invalid or expired token"));
      req.user = { id: String(admin._id), role: "admin", accountType: "admin_account", workspaceId: null, accessToken: token };
      req.auth = { ...(req.auth || {}), accessToken: token, sessionId: payload?.sid ? String(payload.sid) : null };
      return next();
    }

    const user = await User.findById(payload.sub).select("_id role status terminationState accountBlocked tokenVersion");
    if (!user) return next(new HttpError(401, "Invalid or expired token"));
    if (!canLoginStatus(user.status)) return next(new HttpError(403, getBlockedLoginMessage(user.status)));
    if (user.accountBlocked) return next(new HttpError(403, "This user is inactive"));
    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      return next(new HttpError(401, "Session expired. Please login again."));
    }
    if (payload?.sid) {
      const session = await AuthSession.findOne({
        sessionId: String(payload.sid),
        userId: user._id,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }).select("sessionId");
      if (!session) return next(new HttpError(401, "Session expired. Please login again.", { code: "SESSION_REVOKED" }));
    }
    req.user = {
      id: String(user._id),
      role: user.role,
      accountType: "user",
      workspaceId: payload.workspaceId,
      tokenVersion: Number(user.tokenVersion || 0),
      accessToken: token,
    };
    req.auth = { ...(req.auth || {}), accessToken: token, sessionId: payload?.sid ? String(payload.sid) : null };
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired token"));
  }
}

module.exports = { auth };

