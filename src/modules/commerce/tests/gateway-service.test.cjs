require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { CommerceGatewayConnection: Gateway } = require("@infra/database/CommerceGatewayConnection");
const { createGatewayService } = require("../services/gateway.service");
const { decryptCommerceSecret, encryptCommerceSecret } = require("../services/commerceSecrets.service");
const { hash } = require("../domain/gateway");
const ws = "100000000000000000000001", otherWs = "100000000000000000000002", user = "200000000000000000000001";
const manualInput = { environment: "test", keyId: "rzp_test_example1234", keySecret: "example-secret" };
function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => value && typeof value === "object" && "$lte" in value
    ? record[key] <= value.$lte : String(record[key]) === String(value));
}
function fixture(t) {
  const previous = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  t.after(() => previous === undefined ? delete process.env.CREDENTIALS_ENCRYPTION_KEY : process.env.CREDENTIALS_ENCRYPTION_KEY = previous);
  const records = [], sessions = [], calls = { probe: 0, exchange: 0, refresh: 0, authorize: 0 };
  let time = new Date("2026-09-10T12:00:00Z");
  const now = () => new Date(time);
  const cfg = { clientId: "test-client", clientSecret: "test-secret", redirectUri: "https://api.example.com/api/commerce/gateways/oauth/callback" };
  const config = { gatewayEnabled: () => true, oauthEnabled: () => true, oauthConfig: () => cfg,
    webhookConfig: () => ({ ...cfg, secrets: ["example-webhook-secret"] }) };
  const tokenResponse = () => ({ token_type: "Bearer", expires_in: 3600, access_token: `access-${calls.refresh}`,
    refresh_token: `refresh-${calls.refresh}`, public_token: "rzp_test_oauth_example1234", razorpay_account_id: "acc_example123" });
  const provider = { probe: async () => { calls.probe++; }, exchange: async () => { calls.exchange++; return tokenResponse(); },
    refresh: async () => { calls.refresh++; return tokenResponse(); } };
  const repo = {
    list: async (workspaceId) => records.filter((r) => String(r.workspaceId) === String(workspaceId) && r.active),
    active: async (workspaceId, environment) => records.find((r) => String(r.workspaceId) === String(workspaceId) && r.environment === environment && r.active),
    find: async (workspaceId, id) => records.find((r) => String(r.workspaceId) === String(workspaceId) && String(r._id) === String(id)),
    create: async (fields) => {
      if (records.some((r) => r.active && ((String(r.workspaceId) === String(fields.workspaceId) && r.environment === fields.environment)
          || (fields.keyFingerprint && fields.keyFingerprint === r.keyFingerprint)
          || (fields.identityVerified && r.identityVerified && fields.environment === r.environment && fields.merchantAccountId === r.merchantAccountId))))
        throw { code: 11000, message: "private database key" };
      const record = new Gateway(fields).toObject(); records.push(record); return record;
    },
    update: async (workspaceId, id, filter, patch) => {
      const index = records.findIndex((r) => String(r.workspaceId) === String(workspaceId) && String(r._id) === String(id) && matches(r, filter));
      if (index < 0) return null;
      records[index] = { ...records[index], ...patch, revision: records[index].revision + 1 }; return records[index];
    },
    createSession: async (fields) => { const record = { ...fields, usedAt: null }; sessions.push(record); return record; },
    findSession: async (tokenHash, userId, at) => sessions.find((s) => s.tokenHash === tokenHash && s.userId === userId && !s.usedAt && s.expiresAt > at),
    consumeSession: async (session, at) => { const found = sessions.find((s) => s === session && !s.usedAt && s.expiresAt > at); if (!found) return null; found.usedAt = at; return found; },
    claimRefresh: async (record, owner, at) => repo.update(record.workspaceId, record._id,
      { active: true, status: "connected", refreshState: "idle", revision: record.revision, refreshAfter: { $lte: at } },
      { refreshState: "refreshing", refreshLeaseOwner: owner, refreshLeaseUntil: new Date(at.getTime() + 120000) }),
    expireRefreshes: async (at) => { for (const r of [...records]) if (r.active && r.refreshState === "refreshing" && r.refreshLeaseUntil <= at)
      await repo.update(r.workspaceId, r._id, { revision: r.revision }, { refreshState: "unknown", status: "error" }); },
    dueRefreshes: async (at) => records.filter((r) => r.active && r.status === "connected" && r.authType === "oauth" && r.refreshState === "idle" && r.refreshAfter <= at).slice(0, 10),
    revokeAccount: async (environment, clientId, accountId, createdAt) => {
      for (const r of [...records]) if (r.authType === "oauth" && r.environment === environment && r.oauthClientId === clientId
          && r.merchantAccountId === accountId && r.status !== "revoked" && r.oauthAuthorizedAt.getTime() < (createdAt + 1) * 1000)
        await repo.update(r.workspaceId, r._id, { revision: r.revision }, { active: false, status: "revoked", refreshState: "unknown", refreshLeaseOwner: "" });
    },
  };
  const authorization = { allowed: true };
  const service = createGatewayService({ repo, provider, config, now, authorize: async () => {
    calls.authorize++; if (!authorization.allowed) throw new HttpError(403, "Workspace permission denied");
  } });
  const advance = (ms) => { time = new Date(time.getTime() + ms); };
  const start = () => service.startOAuth(ws, user, { environment: "test" });
  const finish = (s) => service.finishOAuth(user, { state: s.state, code: "example-code" }, s.nonce);
  const oauth = async () => (await finish(await start())).gateway;
  const event = (createdAt = Math.floor(time.getTime() / 1000), accountId = "acc_example123") => {
    const raw = Buffer.from(JSON.stringify({ event: "account.app.authorization_revoked", account_id: accountId, created_at: createdAt }));
    return [raw, crypto.createHmac("sha256", "example-webhook-secret").update(raw).digest("hex")];
  };
  return { service, records, sessions, calls, repo, provider, config, cfg, start, finish, oauth, now, advance, event, authorization };
}
test("manual onboarding encrypts workspace-bound credentials, exposes status only and never infers account/native readiness", async (t) => {
  const f = fixture(t); const gateway = await f.service.connectManual(ws, user, manualInput);
  const record = f.records[0];
  assert.equal(f.calls.probe, 1); assert.equal(gateway.identityVerified, false); assert.equal(gateway.nativePaymentStatus, "unverified");
  assert.equal(gateway.webhookStatus, "needs_setup"); assert.equal(gateway.merchantAccountId, undefined);
  assert.equal(record.keyFingerprint, hash(manualInput.keyId));
  assert.equal(JSON.stringify(gateway).includes(manualInput.keySecret), false);
  assert.notEqual(record.keySecretEnc, manualInput.keySecret);
  assert.equal(decryptCommerceSecret(record.keySecretEnc, { workspaceId: ws, recordId: record._id, field: "keySecretEnc" }), manualInput.keySecret);
  assert.deepEqual(await f.service.getMerchantAuthentication(ws, gateway.id, "test"), { authType: "api_keys", keyId: manualInput.keyId, keySecret: manualInput.keySecret });
});
test("historical reconciliation decrypts only the original disconnected manual connection even when new gateway access is disabled", async (t) => {
  const f = fixture(t), gateway = await f.service.connectManual(ws, user, manualInput);
  await f.service.disconnect(ws, gateway.id, { revision: gateway.revision });
  f.config.gatewayEnabled = () => false;
  assert.deepEqual(await f.service.getReconciliationAuthentication(ws, gateway.id, "test"),
    { authType: "api_keys", keyId: manualInput.keyId, keySecret: manualInput.keySecret });
  await assert.rejects(f.service.getReconciliationAuthentication(otherWs, gateway.id, "test"), { statusCode: 404 });
  await assert.rejects(f.service.getReconciliationAuthentication(ws, gateway.id, "live"), { statusCode: 409 });
});
test("historical OAuth reads stop at token expiry or revocation without rotating a disconnected grant", async (t) => {
  const f = fixture(t), gateway = await f.oauth();
  await f.service.disconnect(ws, gateway.id, { revision: gateway.revision });
  assert.equal((await f.service.getReconciliationAuthentication(ws, gateway.id, "test")).authType, "oauth");
  f.advance(3600000);
  await assert.rejects(f.service.getReconciliationAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.equal(f.calls.refresh, 0);
  f.records[0].status = "revoked";
  await assert.rejects(f.service.getReconciliationAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
});
test("manual failures and membership changes do not persist credentials; duplicate connections never overwrite", async (t) => {
  const f = fixture(t);
  f.authorization.allowed = false;
  await assert.rejects(f.service.connectManual(ws, user, manualInput), { statusCode: 403 }); assert.equal(f.records.length, 0);
  f.authorization.allowed = true;
  await f.service.connectManual(ws, user, manualInput);
  await assert.rejects(f.service.connectManual(ws, user, manualInput), { statusCode: 409 });
  await assert.rejects(f.service.connectManual(otherWs, user, manualInput), { statusCode: 409 });
  assert.equal(f.records.length, 1);
});
test("merchant authentication denies wrong tenant, mode, disabled feature and disconnected connections without platform fallback", async (t) => {
  const f = fixture(t); const gateway = await f.service.connectManual(ws, user, manualInput);
  await assert.rejects(f.service.getMerchantAuthentication(otherWs, gateway.id, "test"), { statusCode: 404 });
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "live"), { statusCode: 409 });
  f.config.gatewayEnabled = () => false;
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 503 });
  f.config.gatewayEnabled = () => true;
  await f.service.disconnect(ws, gateway.id, { revision: gateway.revision });
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.ok(f.records[0].keySecretEnc); assert.equal(f.calls.probe, 1);
});
test("OAuth state is hashed, encrypted and bound to user, browser, expiry and original configuration", async (t) => {
  const f = fixture(t); const start = await f.start();
  assert.equal(f.sessions[0].tokenHash, hash(start.state)); assert.notEqual(f.sessions[0].tokenHash, start.state);
  assert.equal(f.sessions[0].dataEnc.includes(start.nonce), false);
  assert.equal(new URL(start.authorizationUrl).searchParams.get("scope"), "read_write");
  await assert.rejects(f.service.finishOAuth("other-user", { state: start.state, code: "code" }, start.nonce), { statusCode: 400 });
  await assert.rejects(f.service.finishOAuth(user, { state: start.state, code: "code" }, "a".repeat(64)), { statusCode: 400 });
  f.cfg.clientId = "changed-client";
  await assert.rejects(f.finish(start), { statusCode: 400 }); f.cfg.clientId = "test-client";
  f.advance(10 * 60000);
  await assert.rejects(f.finish(start), { statusCode: 400 }); assert.equal(f.calls.exchange, 0);
});
test("OAuth success stores verified provider identity but leaves payment webhooks/native unverified; callback replay never exchanges again", async (t) => {
  const f = fixture(t); const start = await f.start(); const result = await f.finish(start);
  assert.equal(result.workspaceId, ws); assert.equal(result.gateway.identityVerified, true);
  assert.equal(result.gateway.merchantAccountId, "acc_example123"); assert.equal(result.gateway.status, "connected");
  assert.equal(result.gateway.nativePaymentStatus, "unverified"); assert.equal(result.gateway.webhookStatus, "needs_setup");
  assert.equal(f.calls.exchange, 1);
  await assert.rejects(f.finish(start), { statusCode: 400 }); assert.equal(f.calls.exchange, 1);
  assert.equal(JSON.stringify(result).includes("access-0"), false);
});
test("simultaneous OAuth callbacks consume state once before token exchange", async (t) => {
  const f = fixture(t); const start = await f.start();
  const results = await Promise.allSettled([f.finish(start), f.finish(start)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(f.calls.exchange, 1);
});
test("OAuth cancellation and permission revocation cannot create grants", async (t) => {
  const f = fixture(t); const start = await f.start();
  const cancelled = await f.service.finishOAuth(user, { state: start.state, error: "access_denied", error_description: "untrusted" }, start.nonce);
  assert.equal(cancelled.cancelled, true); assert.equal(JSON.stringify(cancelled).includes("untrusted"), false);
  const next = await f.start(); f.authorization.allowed = false;
  await assert.rejects(f.finish(next), { statusCode: 403 }); assert.equal(f.calls.exchange, 0);
});
test("revocation during initial probe fences onboarding activation", async (t) => {
  const f = fixture(t);
  f.provider.probe = async () => { await f.service.receiveRevocation("test", ...f.event()); };
  await assert.rejects(f.oauth(), { statusCode: 409 });
  assert.equal(f.records[0].status, "revoked"); assert.equal(f.records[0].active, false);
});
test("concurrent refresh rotates once and persists both tokens atomically", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  const results = await Promise.allSettled([f.service.getMerchantAuthentication(ws, gateway.id, "test"), f.service.getMerchantAuthentication(ws, gateway.id, "test")]);
  assert.equal(f.calls.refresh, 1); assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.records[0].refreshState, "idle");
  assert.equal((await f.service.getMerchantAuthentication(ws, gateway.id, "test")).accessToken, "access-1");
  assert.equal(decryptCommerceSecret(f.records[0].refreshTokenEnc, { workspaceId: ws, recordId: gateway.id, field: "refreshTokenEnc" }), "refresh-1");
});
test("ambiguous refresh is blocked and never retries the now potentially invalid old token", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  f.provider.refresh = async () => { f.calls.refresh++; throw new Error("timeout with sensitive request"); };
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.equal(f.records[0].refreshState, "unknown"); assert.equal(f.records[0].status, "error");
  await f.service.maintain();
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.equal(f.calls.refresh, 1);
});
test("expired refresh lease after crash requires reconnection rather than automatic token resubmission", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  await f.repo.claimRefresh(f.records[0], "crashed-worker", f.now()); f.advance(120000);
  await f.service.maintain();
  assert.equal(f.records[0].refreshState, "unknown"); assert.equal(f.calls.refresh, 0);
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
});
test("revocation during refresh prevents a new token response from reactivating the gateway", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  const original = f.provider.refresh;
  f.provider.refresh = async (...args) => { const response = await original(...args); await f.service.receiveRevocation("test", ...f.event()); return response; };
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.equal(f.records[0].status, "revoked"); assert.equal(f.records[0].active, false);
});
test("disconnect preserves history, enforces revision and refuses an in-flight token refresh", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  await assert.rejects(f.service.disconnect(ws, gateway.id, { revision: 999 }), { statusCode: 409 });
  const claimed = await f.repo.claimRefresh(f.records[0], "worker", f.now());
  await assert.rejects(f.service.disconnect(ws, gateway.id, { revision: claimed.revision }), { statusCode: 409 });
  f.advance(120001);
  const disconnected = await f.service.disconnect(ws, gateway.id, { revision: claimed.revision });
  assert.equal(disconnected.active, false); assert.equal(disconnected.refreshState, "unknown"); assert.ok(f.records[0].accessTokenEnc);
});
test("signed revocation is durable, idempotent, environment-bound and cannot revoke a newer grant on late delivery", async (t) => {
  const f = fixture(t); const first = await f.oauth(); const event = f.event();
  await f.service.receiveRevocation("live", ...event); assert.equal(f.records[0].active, true);
  await f.service.receiveRevocation("test", ...event); const revision = f.records[0].revision;
  await f.service.receiveRevocation("test", ...event); assert.equal(f.records[0].revision, revision);
  assert.equal((await f.service.get(ws, first.id)).status, "revoked");
  f.advance(2000); await f.oauth();
  await f.service.receiveRevocation("test", ...event); assert.equal(f.records[1].active, true);
});
test("invalid signature, unknown account and future event cannot change a merchant connection", async (t) => {
  const f = fixture(t); await f.oauth(); const event = f.event();
  await assert.rejects(f.service.receiveRevocation("test", event[0], "0".repeat(64)), { statusCode: 401 });
  await f.service.receiveRevocation("test", ...f.event(undefined, "acc_other"));
  await assert.rejects(f.service.receiveRevocation("test", ...f.event(Math.floor(f.now().getTime() / 1000) + 301)), { statusCode: 400 });
  assert.equal(f.records[0].active, true);
});
test("verification records definitive authentication rejection and recovers manual credentials only with a fresh successful probe", async (t) => {
  const f = fixture(t); const gateway = await f.service.connectManual(ws, user, manualInput);
  f.provider.probe = async () => { const error = new HttpError(422, "Rejected"); error.authenticationRejected = true; throw error; };
  await assert.rejects(f.service.verify(ws, gateway.id, { revision: gateway.revision }), { statusCode: 422 });
  assert.equal(f.records[0].status, "error");
  f.provider.probe = async () => {};
  const result = await f.service.verify(ws, gateway.id, { revision: f.records[0].revision });
  assert.equal(result.status, "connected"); assert.equal(result.identityVerified, false);
});
test("encrypted credential copied from another record cannot be used", async (t) => {
  const f = fixture(t); const gateway = await f.service.connectManual(ws, user, manualInput);
  f.records[0].keySecretEnc = encryptCommerceSecret("foreign-secret", { workspaceId: otherWs, recordId: new mongoose.Types.ObjectId(), field: "keySecretEnc" });
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 503 });
});
test("provider success followed by token persistence failure stays blocked and cannot repeat refresh", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  const update = f.repo.update;
  f.repo.update = async (workspaceId, id, filter, patch) => {
    if (patch.accessTokenEnc) throw new Error("database unavailable");
    return update(workspaceId, id, filter, patch);
  };
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.equal(f.calls.refresh, 1); assert.equal(f.records[0].refreshState, "unknown");
  await f.service.maintain(); assert.equal(f.calls.refresh, 1);
});
test("a failed initial OAuth probe leaves an unusable, inspectable connection without claiming credential verification", async (t) => {
  const f = fixture(t); f.provider.probe = async () => { throw new HttpError(502, "Provider unavailable"); };
  await assert.rejects(f.oauth(), { statusCode: 502 });
  assert.equal(f.records[0].status, "error"); assert.equal(f.records[0].lastErrorCode, "verification_pending");
  assert.equal(f.records[0].credentialsVerifiedAt, null);
  await assert.rejects(f.service.getMerchantAuthentication(ws, f.records[0]._id, "test"), { statusCode: 409 });
});
test("a refresh response for a different merchant or environment cannot replace the stored credentials", async (t) => {
  const f = fixture(t); const gateway = await f.oauth(); f.advance(55 * 60000);
  const before = f.records[0].accessTokenEnc;
  f.provider.refresh = async () => ({ token_type: "Bearer", expires_in: 3600, access_token: "foreign-access", refresh_token: "foreign-refresh",
    public_token: "rzp_live_oauth_example1234", razorpay_account_id: "acc_other" });
  await assert.rejects(f.service.getMerchantAuthentication(ws, gateway.id, "test"), { statusCode: 409 });
  assert.equal(f.records[0].accessTokenEnc, before); assert.equal(f.records[0].refreshState, "unknown");
});
