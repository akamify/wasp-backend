const { CommerceGatewayConnection: Gateway } = require("@infra/database/CommerceGatewayConnection");
const { CommerceSession: Session } = require("@infra/database/CommerceSession");
const { byWorkspace } = require("./scope");
const { REFRESH_LEASE_MS } = require("../domain/gateway");
const secrets = "+keyIdEnc +keySecretEnc +accessTokenEnc +refreshTokenEnc +refreshLeaseOwner";
const writeConcern = { w: "majority", j: true, wtimeout: 10000 };
const options = { returnDocument: "after", runValidators: true, writeConcern };
function list(workspaceId) { return Gateway.find(byWorkspace(workspaceId, { active: true })).read("primary").limit(2).sort({ environment: 1 }).lean(); }
function active(workspaceId, environment) { return Gateway.findOne(byWorkspace(workspaceId, { active: true, provider: "razorpay", environment })).read("primary").lean(); }
function find(workspaceId, id) { return Gateway.findOne(byWorkspace(workspaceId, { _id: id })).read("primary").select(secrets).lean(); }
async function create(fields) { const [record] = await Gateway.create([fields], { writeConcern }); return record; }
function update(workspaceId, id, filter, patch) {
  return Gateway.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, ...filter }),
    { $set: patch, $inc: { revision: 1 } }, options).select(secrets).lean();
}
async function createSession(fields) { const [record] = await Session.create([fields], { writeConcern }); return record; }
function findSession(tokenHash, userId, now) {
  // The unpredictable state plus authenticated user discovers its immutable workspace.
  return Session.findOne({ kind: "oauth", tokenHash, userId, usedAt: null, expiresAt: { $gt: now } }).read("primary").select("+dataEnc").lean();
}
function consumeSession(session, now) {
  return Session.findOneAndUpdate(byWorkspace(session.workspaceId, { _id: session._id, kind: "oauth", userId: session.userId,
    usedAt: null, expiresAt: { $gt: now } }), { $set: { usedAt: now } }, options).lean();
}
function claimRefresh(record, owner, now) {
  return update(record.workspaceId, record._id, { revision: record.revision, active: true, authType: "oauth",
    status: "connected", refreshState: "idle", refreshAfter: { $lte: now } }, {
    refreshState: "refreshing", refreshLeaseOwner: owner, refreshLeaseUntil: new Date(now.getTime() + REFRESH_LEASE_MS),
  });
}
function expireRefreshes(now) {
  // A crashed process may already have rotated the token remotely. Never reclaim its old token.
  return Gateway.updateMany({ active: true, authType: "oauth", refreshState: "refreshing", refreshLeaseUntil: { $lte: now } },
    { $set: { refreshState: "unknown", status: "error", lastErrorCode: "oauth_reconnect_required", refreshLeaseOwner: "", refreshLeaseUntil: null }, $inc: { revision: 1 } }, { writeConcern });
}
function dueRefreshes(now) {
  // Global discovery is worker-only; each subsequent claim/write is workspace-scoped.
  return Gateway.find({ active: true, authType: "oauth", status: "connected", refreshState: "idle", refreshAfter: { $lte: now } })
    .sort({ refreshAfter: 1 }).limit(10).select("workspaceId environment").lean();
}
function revokeAccount(environment, clientId, accountId, createdAt) {
  // Signed account identity is the only cross-workspace lookup. Includes disconnected history.
  // Same-second authorization is conservatively revoked; later authorizations survive stale delivery.
  return Gateway.updateMany({ provider: "razorpay", environment, authType: "oauth", oauthClientId: clientId,
    merchantAccountId: accountId, identityVerified: true, status: { $ne: "revoked" },
    oauthAuthorizedAt: { $lt: new Date((createdAt + 1) * 1000) } }, {
    $set: { active: false, status: "revoked", lastErrorCode: "oauth_authorization_revoked", refreshState: "unknown",
      refreshLeaseOwner: "", refreshLeaseUntil: null }, $inc: { revision: 1 },
  }, { writeConcern });
}
module.exports = { list, active, find, create, update, createSession, findSession, consumeSession,
  claimRefresh, expireRefreshes, dueRefreshes, revokeAccount };
