const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { User } = require("@infra/database/User");
const { AuthSession } = require("@infra/database/AuthSession");
const { TrustedDevice } = require("@infra/database/TrustedDevice");
const repo = require("@modules/auth/auth.repository");
const { ensureDefaultWorkspace } = require("@modules/auth/auth.service.user.workspace");
const { signToken } = require("@modules/auth/auth.tokens");
const { setAuthCookies, clearAuthCookies, readAuthCookies } = require("@modules/auth/auth.cookie");
const { canLoginStatus, getBlockedLoginMessage } = require("@shared/utils/userStatus");

const DAY_MS = 24 * 60 * 60 * 1000;

function roleConfig(role) {
  if (String(role || "") === "super_admin") {
    return { refreshMaxAgeMs: 1 * DAY_MS, trustedDeviceMaxAgeMs: 1 * DAY_MS, trustedEnabled: false };
  }
  if (String(role || "") === "admin") {
    return { refreshMaxAgeMs: 7 * DAY_MS, trustedDeviceMaxAgeMs: 7 * DAY_MS, trustedEnabled: true };
  }
  return { refreshMaxAgeMs: 15 * DAY_MS, trustedDeviceMaxAgeMs: 15 * DAY_MS, trustedEnabled: true };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function requestMeta(req) {
  return {
    ip: String(req?.ip || ""),
    userAgent: String(req?.headers?.["user-agent"] || ""),
  };
}

async function findActiveTrustedDevice({ userId, role, trustedDeviceId }) {
  const cfg = roleConfig(role);
  if (!cfg.trustedEnabled || !trustedDeviceId) return null;
  return TrustedDevice.findOne({
    userId,
    role,
    deviceIdHash: sha256Hex(trustedDeviceId),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
}

async function trustDevice({ userId, role, trustedDeviceId, req }) {
  const cfg = roleConfig(role);
  if (!cfg.trustedEnabled || !trustedDeviceId) return null;
  const now = new Date();
  const meta = requestMeta(req);
  return TrustedDevice.findOneAndUpdate(
    { userId, role, deviceIdHash: sha256Hex(trustedDeviceId) },
    {
      $set: {
        trustedAt: now,
        expiresAt: new Date(now.getTime() + cfg.trustedDeviceMaxAgeMs),
        lastUsedAt: now,
        revokedAt: null,
        revokedReason: "",
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      $setOnInsert: {
        userId,
        role,
        deviceIdHash: sha256Hex(trustedDeviceId),
      },
    },
    { upsert: true, new: true }
  );
}

async function revokeSessionById(sessionId, reason = "logout") {
  if (!sessionId) return;
  await AuthSession.updateOne({ sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

async function revokeAllSessionsForUser(userId, reason = "security_event") {
  await AuthSession.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

async function revokeAllTrustedDevicesForUser(userId, reason = "security_event") {
  await TrustedDevice.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

async function createBrowserSession({ user, workspaceId, trustedDeviceId, req, res }) {
  const cfg = roleConfig(user.role);
  const sessionId = randomToken(24);
  const refreshToken = randomToken(48);
  const now = new Date();
  const meta = requestMeta(req);
  const expiresAt = new Date(now.getTime() + cfg.refreshMaxAgeMs);
  const accessToken = signToken({ user, workspaceId, sessionId });

  await AuthSession.create({
    userId: user._id,
    role: user.role,
    sessionId,
    refreshTokenHash: sha256Hex(refreshToken),
    deviceIdHash: sha256Hex(String(trustedDeviceId || "")),
    workspaceId: String(workspaceId || ""),
    trustedAt: trustedDeviceId ? now : null,
    expiresAt,
    lastUsedAt: now,
    ip: meta.ip,
    userAgent: meta.userAgent,
    revokedAt: null,
    revokedReason: "",
    tokenVersion: Number(user.tokenVersion || 0),
  });

  if (trustedDeviceId) {
    await trustDevice({ userId: user._id, role: user.role, trustedDeviceId, req });
  }

  setAuthCookies(res, { accessToken, refreshToken, refreshMaxAgeMs: cfg.refreshMaxAgeMs });
  return { token: accessToken, expiresAt };
}

async function loadActiveSessionByRefreshToken(refreshToken) {
  return AuthSession.findOne({
    refreshTokenHash: sha256Hex(String(refreshToken || "")),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).select("+refreshTokenHash");
}

async function hydrateActiveUser(userId) {
  const user = await User.findById(userId).select("_id role email name phone status terminationState accountBlocked tokenVersion twoFactorEnabled adminPermissions emailVerified createdAt");
  if (!user) throw new HttpError(401, "Session expired. Please login again.", { code: "SESSION_REVOKED" });
  if (!canLoginStatus(user.status)) throw new HttpError(403, getBlockedLoginMessage(user.status));
  if (user.accountBlocked) throw new HttpError(403, "This user is inactive");
  return user;
}

async function resolveWorkspace(user, selectedWorkspaceId, fallbackWorkspaceId = "") {
  if (selectedWorkspaceId) {
    const requested = await repo.findWorkspaceForUserAndId({ workspaceId: selectedWorkspaceId, ownerId: user._id });
    if (requested) return requested;
  }
  if (fallbackWorkspaceId) {
    const existing = await repo.findWorkspaceForUserAndId({ workspaceId: fallbackWorkspaceId, ownerId: user._id });
    if (existing) return existing;
  }
  return ensureDefaultWorkspace(user);
}

async function refreshBrowserSession({ req, res, selectedWorkspaceId = "" }) {
  const { refreshToken, trustedDeviceId } = readAuthCookies(req);
  if (!refreshToken) throw new HttpError(401, "Session expired. Please login again.", { code: "SESSION_EXPIRED" });
  const session = await loadActiveSessionByRefreshToken(refreshToken);
  if (!session) throw new HttpError(401, "Session expired. Please login again.", { code: "SESSION_EXPIRED" });
  if (!trustedDeviceId || sha256Hex(trustedDeviceId) !== String(session.deviceIdHash || "")) {
    await revokeSessionById(session.sessionId, "device_mismatch");
    throw new HttpError(401, "Device trust expired. Please sign in again.", { code: "DEVICE_NOT_TRUSTED" });
  }

  const user = await hydrateActiveUser(session.userId);
  if (Number(session.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
    await revokeSessionById(session.sessionId, "token_version_mismatch");
    throw new HttpError(401, "Session expired. Please login again.", { code: "SESSION_REVOKED" });
  }

  const workspace = await resolveWorkspace(user, selectedWorkspaceId, session.workspaceId || "");
  const nextRefreshToken = randomToken(48);
  session.refreshTokenHash = sha256Hex(nextRefreshToken);
  session.workspaceId = String(workspace?._id || session.workspaceId || "");
  session.lastUsedAt = new Date();
  session.expiresAt = new Date(Date.now() + roleConfig(user.role).refreshMaxAgeMs);
  await session.save();

  const accessToken = signToken({ user, workspaceId: workspace._id, sessionId: session.sessionId });
  setAuthCookies(res, {
    accessToken,
    refreshToken: nextRefreshToken,
    refreshMaxAgeMs: roleConfig(user.role).refreshMaxAgeMs,
  });

  return {
    success: true,
    state: "verified",
    token: accessToken,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      emailVerified: user.emailVerified !== false,
      createdAt: user.createdAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
    workspace: workspace ? { id: String(workspace._id), name: workspace.name, plan: workspace.plan } : null,
  };
}

function clearBrowserSession(res) {
  clearAuthCookies(res);
}

module.exports = {
  roleConfig,
  findActiveTrustedDevice,
  trustDevice,
  revokeSessionById,
  revokeAllSessionsForUser,
  revokeAllTrustedDevicesForUser,
  createBrowserSession,
  refreshBrowserSession,
  clearBrowserSession,
};
