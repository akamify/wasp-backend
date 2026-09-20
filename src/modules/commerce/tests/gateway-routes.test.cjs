require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { once } = require("node:events");
const { jwtSecret } = require("@core/config/env");
const { User } = require("@infra/database/User");
const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
const { HttpError } = require("@shared/utils/httpError");
const { errorHandler } = require("@core/middleware/errorHandler");
const readiness = require("../services/gatewayReadiness.service");
const service = require("../services/gateway.service");
const audit = require("@shared/services/auditLog.service");
const { gatewayErrorBoundary } = require("../routes/gatewayHttp");

test("gateway HTTP routes enforce real authentication, workspace permissions, JSON-only writes, private cookies and raw public revocation", async (t) => {
  const workspaceId = "100000000000000000000001", userId = "200000000000000000000001", gatewayId = "300000000000000000000001";
  const state = "a".repeat(64), nonce = "b".repeat(64);
  let role = "viewer", member = true, ready = true, calls = 0, webhookCalls = 0;
  t.mock.method(User, "findById", () => ({ select: async () => ({ _id: userId, role: "user", status: "active", tokenVersion: 0 }) }));
  t.mock.method(Workspace, "findOne", async (query) => query._id === workspaceId ? { _id: workspaceId, ownerId: "other", isActive: true, status: "active" } : null);
  t.mock.method(WorkspaceMember, "findOne", async () => member ? { role, permissionsOverride: {} } : null);
  t.mock.method(readiness, "assertGatewayReady", async () => { if (!ready) throw new HttpError(503, "Disabled"); });
  t.mock.method(audit, "writeAuditLog", async (_req, data) => { assert.equal(JSON.stringify(data).includes("example-secret"), false); });
  t.mock.method(service, "list", async (ws) => { calls++; assert.equal(ws, workspaceId); return []; });
  t.mock.method(service, "connectManual", async (ws, uid, input) => {
    calls++; assert.equal(ws, workspaceId); assert.equal(uid, userId); assert.equal(input.keyId, "rzp_test_example1234");
    return { id: gatewayId, environment: "test", authType: "api_keys", status: "connected", revision: 1 };
  });
  t.mock.method(service, "startOAuth", async () => ({ state, nonce, authorizationUrl: `https://auth.razorpay.com/authorize?state=${state}`, expiresAt: new Date() }));
  t.mock.method(service, "finishOAuth", async (uid, query, browserNonce) => {
    assert.equal(uid, userId); assert.equal(query.state, state); assert.equal(browserNonce, nonce);
    return { cancelled: true, workspaceId };
  });
  t.mock.method(service, "receiveRevocation", async (environment, raw, signature) => {
    webhookCalls++; assert.equal(environment, "test"); assert.ok(Buffer.isBuffer(raw)); assert.equal(raw.toString(), '{ "event": "test" }');
    if (signature !== "valid-test-signature") throw new HttpError(401, "Invalid OAuth webhook signature.");
  });
  t.mock.method(service, "get", async () => { throw new Error("sensitive database or credential detail"); });
  let nativeCalls = 0;
  t.mock.method(require("../services/nativePayments.service"), "configure", async (ws, gid, uid, input) => {
    nativeCalls++; assert.equal(ws, workspaceId); assert.equal(gid, gatewayId); assert.equal(uid, userId);
    assert.deepEqual(input, { revision: 1, configurationName: "Merchant config" }); return { acceptedBinding: false };
  });
  const app = express();
  app.use("/api/commerce/gateways/oauth/webhooks", express.raw({ type: "application/json", limit: "64kb", inflate: false }));
  app.use(express.json({ limit: "64kb" })); app.use(express.urlencoded({ extended: false }));
  app.use("/api/commerce/gateways", require("../routes/gateway.routes"));
  app.use(gatewayErrorBoundary); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/commerce/gateways`;
  const token = jwt.sign({ sub: userId, tokenVersion: 0 }, jwtSecret, { expiresIn: "1m" });
  const headers = { Authorization: `Bearer ${token}`, "x-workspace-id": workspaceId, "Content-Type": "application/json" };
  const post = (path, body, suppliedHeaders = headers) => fetch(`${base}${path}`, { method: "POST", headers: suppliedHeaders, body: JSON.stringify(body) });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 403);
  assert.equal((await post(`/${gatewayId}/native`, { revision: 1, configurationName: "Merchant config" })).status, 403);
  role = "manager"; assert.equal((await fetch(base, { headers })).status, 403);
  role = "admin"; member = false; assert.equal((await fetch(base, { headers })).status, 404);
  member = true; assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await post(`/${gatewayId}/native`, { revision: 1, configurationName: "Merchant config", nativePaymentStatus: "active" })).status, 400);
  const nativeResult = await post(`/${gatewayId}/native`, { revision: 1, configurationName: "Merchant config" });
  assert.equal(nativeResult.status, 200); assert.equal((await nativeResult.json()).acceptedBinding, false); assert.equal(nativeCalls, 1);
  assert.equal(calls, 1);
  assert.equal((await fetch(base, { headers: { ...headers, "x-workspace-id": "100000000000000000000002" } })).status, 404);
  ready = false; assert.equal((await fetch(base, { headers })).status, 503); ready = true;
  const manual = { environment: "test", keyId: "rzp_test_example1234", keySecret: "example-secret" };
  assert.equal((await post("/manual", { ...manual, identityVerified: true })).status, 400);
  assert.equal((await post("/manual", manual, { ...headers, "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("/manual", manual)).status, 201);
  assert.equal(calls, 2);
  const malformed = await fetch(`${base}/manual`, { method: "POST", headers, body: '{"keySecret":"sensitive-private-value",broken' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.text()).includes("sensitive"), false);
  const failure = await fetch(`${base}/${gatewayId}`, { headers });
  assert.equal(failure.status, 503); assert.equal((await failure.text()).includes("sensitive"), false);
  const start = await post("/oauth/start", { environment: "test" });
  assert.equal(start.status, 200);
  const cookie = start.headers.get("set-cookie");
  assert.match(cookie, /__Host-commerce_oauth_/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  assert.equal((await start.text()).includes(nonce), false);
  const callback = await fetch(`${base}/oauth/callback?state=${state}&error=access_denied`, {
    headers: { Authorization: `Bearer ${token}`, Cookie: cookie.split(";")[0], "x-workspace-id": "other-selection" },
  });
  assert.equal(callback.status, 200); assert.equal((await callback.json()).workspaceId, workspaceId);
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer"); assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.match(callback.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/);
  const previousFrontend = process.env.FRONTEND_BASE_URL;
  process.env.FRONTEND_BASE_URL = "https://app.example.com";
  t.after(() => previousFrontend === undefined ? delete process.env.FRONTEND_BASE_URL : process.env.FRONTEND_BASE_URL = previousFrontend);
  const browserCallback = await fetch(`${base}/oauth/callback?state=${state}&error=access_denied`, {
    redirect: "manual", headers: { Authorization: `Bearer ${token}`, Cookie: cookie.split(";")[0], Accept: "text/html" },
  });
  assert.equal(browserCallback.status, 303);
  assert.equal(browserCallback.headers.get("location"), "https://app.example.com/app/commerce/settings?oauth=cancelled");
  const publicEvent = (signature) => fetch(`${base}/oauth/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": signature }, body: '{ "event": "test" }' });
  assert.equal((await publicEvent("invalid")).status, 401); assert.equal((await publicEvent("valid-test-signature")).status, 200);
  assert.equal(webhookCalls, 2);
});
