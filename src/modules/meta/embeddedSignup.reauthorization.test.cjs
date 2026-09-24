require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createCatalogReauthorizationService,
  validateTokenScopes,
} = require("./services/embeddedSignup.service");
const { serializeWhatsAppConnection } = require("@shared/services/whatsappConnectionMetadataService");
const { resolveActiveConnection } = require("@shared/services/whatsappConnectionService");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");

const workspaceId = "100000000000000000000001";
const current = {
  _id: "200000000000000000000001",
  wabaId: "111",
  phoneNumberId: "222",
  graphApiVersion: "v25.0",
  isActive: true,
  status: "active",
};
const debug = {
  is_valid: true,
  app_id: "app-1",
  scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "catalog_management", "business_management"],
  granular_scopes: [
    { scope: "whatsapp_business_management", target_ids: ["111"] },
    { scope: "catalog_management", target_ids: ["4351882411734068"] },
  ],
};

function fixture(overrides = {}) {
  const calls = { exchanged: 0, discovered: 0, subscribed: 0, updates: [], activities: [] };
  const service = createCatalogReauthorizationService({
    findActiveConnection: async () => ({ ...current }),
    exchange: async () => { calls.exchanged++; return { token: "new-token", appId: "app-1" }; },
    debugToken: async () => debug,
    validateScopes: validateTokenScopes,
    discoverPhone: async (input) => { calls.discovered++; assert.equal(input.wabaId, "111"); assert.equal(input.phoneNumberId, "222"); },
    subscribe: async (input) => { calls.subscribed++; assert.equal(input.wabaId, "111"); },
    encryptAccessToken: (value) => `encrypted:${value}`,
    encryptBusinessToken: (value) => `business:${value}`,
    updateConnection: async (filter, update) => { calls.updates.push({ filter, update }); return { acknowledged: true, modifiedCount: 1 }; },
    recordActivity: async (entry) => { calls.activities.push(entry); },
    ...overrides,
  });
  return { service, calls };
}

const request = { workspace: { id: workspaceId }, user: { id: "300000000000000000000001" },
  code: "one-time-code", wabaId: "111", phoneNumberId: "222" };

test("catalog reauthorization replaces only the same active connection after every verification", async () => {
  const { service, calls } = fixture();
  const result = await service(request);
  assert.ok(result.grantedScopes.includes("catalog_management"));
  assert.ok(result.grantedScopes.includes("business_management"));
  assert.deepEqual(result.catalogIds, ["4351882411734068"]);
  assert.equal(calls.exchanged, 1);
  assert.equal(calls.discovered, 1);
  assert.equal(calls.subscribed, 1);
  assert.equal(calls.updates.length, 1);
  const { filter, update } = calls.updates[0];
  assert.deepEqual(filter, { _id: current._id, workspaceId, isActive: true, status: "active", wabaId: "111", phoneNumberId: "222" });
  assert.equal(update.$set.accessTokenEnc, "encrypted:new-token");
  assert.equal(update.$set.businessTokenEnc, "business:new-token");
  assert.ok(update.$set.tokenDebugSummary.scopes.includes("business_management"));
  assert.equal(update.$set.lastEditedReason, "catalog_permissions_reauthorized");
  assert.equal(update.$set.status, undefined);
  assert.equal(update.$set.onboardingStage, undefined);
  assert.equal(calls.activities[0].action, "whatsapp.catalog_permissions_reauthorized");
  assert.equal(JSON.stringify(calls.activities[0]).includes("new-token"), false);
});

test("different WABA or phone is rejected before exchanging or changing credentials", async () => {
  for (const patch of [{ wabaId: "999" }, { phoneNumberId: "999" }, { phoneNumberId: "" }]) {
    const { service, calls } = fixture();
    await assert.rejects(service({ ...request, ...patch }), { statusCode: 409 });
    assert.equal(calls.exchanged, 0);
    assert.equal(calls.updates.length, 0);
  }
});

test("a catalog target cannot satisfy the selected WABA target check", () => {
  assert.throws(() => validateTokenScopes({
    ...debug,
    granular_scopes: [
      { scope: "whatsapp_business_management", target_ids: ["999"] },
      { scope: "catalog_management", target_ids: ["111"] },
    ],
  }, "111", "app-1"), /not scoped to the selected WhatsApp Business Account/);
});

test("missing catalog scope and provider verification failures preserve the old token", async () => {
  const missing = fixture({ debugToken: async () => ({
    ...debug,
    scopes: debug.scopes.filter((scope) => scope !== "catalog_management"),
    granular_scopes: debug.granular_scopes.filter((scope) => scope.scope !== "catalog_management"),
  }) });
  await assert.rejects(missing.service(request), (error) => {
    assert.equal(error.message, "Meta did not grant the permissions required to manage catalogs.");
    assert.deepEqual(error.details.missingScopes, ["catalog_management"]);
    assert.deepEqual(error.details.requiredAssets, ["WhatsApp accounts", "Catalogs"]);
    return true;
  });
  assert.equal(missing.calls.updates.length, 0);

  const subscriptionFailure = fixture({ subscribe: async () => { throw new Error("provider unavailable"); } });
  await assert.rejects(subscriptionFailure.service(request), /provider unavailable/);
  assert.equal(subscriptionFailure.calls.updates.length, 0);
});

test("catalog scope without granular catalog targets still replaces the token", async () => {
  const missingAsset = fixture({ debugToken: async () => ({
    ...debug,
    granular_scopes: debug.granular_scopes.filter((scope) => scope.scope !== "catalog_management"),
  }) });
  const result = await missingAsset.service(request);
  assert.deepEqual(result.catalogIds, []);
  assert.equal(missingAsset.calls.discovered, 1);
  assert.equal(missingAsset.calls.updates.length, 1);
});

test("an active-connection race fails closed instead of reporting permission success", async () => {
  const { service, calls } = fixture({ updateConnection: async () => ({ acknowledged: true, modifiedCount: 0 }) });
  await assert.rejects(service(request), { statusCode: 409 });
  assert.equal(calls.updates.length, 0);
});

test("connection response treats granular catalog targets as informational", () => {
  const base = { ...current, isValid: true, connectionMode: "customer_embedded_signup", onboardingStage: "READY", registrationStatus: "COMPLETED",
    tokenDebugSummary: { scopes: ["whatsapp_business_management"], granularScopes: [] } };
  const missing = serializeWhatsAppConnection(base);
  assert.deepEqual(missing.catalogPermission, { granted: false, authorizationRequired: true, catalogIds: [] });
  const scopeOnly = serializeWhatsAppConnection({ ...base,
    tokenDebugSummary: { scopes: [], granularScopes: [{ scope: "catalog_management", target_ids: [] }] } });
  assert.deepEqual(scopeOnly.catalogPermission, { granted: true, authorizationRequired: false, catalogIds: [] });
  const granted = serializeWhatsAppConnection({ ...base,
    tokenDebugSummary: { scopes: [], granularScopes: [{ scope: "catalog_management", target_ids: ["4351882411734068"] }] } });
  assert.deepEqual(granted.catalogPermission, {
    granted: true,
    authorizationRequired: false,
    catalogIds: ["4351882411734068"],
  });
  assert.equal(JSON.stringify(granted).includes("accessToken"), false);
});

test("active connection projection includes persisted token scopes", async (t) => {
  let selected = "";
  const row = { connectionMode: "customer_embedded_signup", tokenDebugSummary: debug,
    wabaId: "111", phoneNumberId: "222", accessTokenEnc: "" };
  t.mock.method(WhatsAppCredentials, "find", () => ({
    sort() { return this; },
    select(fields) { selected = fields; return Promise.resolve([row]); },
  }));
  const result = await resolveActiveConnection(workspaceId);
  assert.equal(result.tokenDebug, debug);
  assert.match(selected, /(?:^|\s)tokenDebugSummary(?:\s|$)/);
  assert.doesNotMatch(selected, /\+tokenDebugSummary/);
});

test("reauthorization HTTP route requires auth, workspace access, permission and strict asset IDs", async (t) => {
  const express = require("express");
  const jwt = require("jsonwebtoken");
  const { once } = require("node:events");
  const { jwtSecret } = require("@core/config/env");
  const { User } = require("@infra/database/User");
  const { Workspace } = require("@infra/database/Workspace");
  const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
  const service = require("./services/embeddedSignup.service");
  const { errorHandler } = require("@core/middleware/errorHandler");
  const userId = "300000000000000000000001";
  let role = "viewer", calls = 0;
  t.mock.method(User, "findById", () => ({ select: async () => ({ _id: userId, role: "user", status: "active", tokenVersion: 0 }) }));
  t.mock.method(Workspace, "findOne", async (query) => query._id === workspaceId
    ? { _id: workspaceId, ownerId: "someone-else", isActive: true, status: "active" } : null);
  t.mock.method(WorkspaceMember, "findOne", async () => ({ role, permissionsOverride: {} }));
  t.mock.method(service, "reauthorizeCatalogPermissions", async ({ workspace, code, wabaId, phoneNumberId }) => {
    calls++;
    assert.equal(String(workspace.id), workspaceId);
    assert.equal(code, "code"); assert.equal(wabaId, "111"); assert.equal(phoneNumberId, "222");
    return { grantedScopes: ["catalog_management"], catalogIds: ["4351882411734068"] };
  });
  const router = require("@core/routes/whatsappIntegrationRoutes");
  const app = express();
  app.use(express.json());
  app.use("/integrations/whatsapp", router);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/integrations/whatsapp/connection/reauthorize-catalog`;
  const token = jwt.sign({ sub: userId, tokenVersion: 0 }, jwtSecret, { expiresIn: "1m" });
  const headers = { Authorization: `Bearer ${token}`, "x-workspace-id": workspaceId, "Content-Type": "application/json" };
  const valid = JSON.stringify({ code: "code", waba_id: "111", phone_number_id: "222" });
  assert.equal((await fetch(url, { method: "POST", body: valid })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers, body: valid })).status, 403);
  role = "admin";
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ code: "code", waba_id: "invalid", phone_number_id: "222" }) })).status, 400);
  const response = await fetch(url, { method: "POST", headers, body: valid });
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.catalogPermission.granted, true);
  assert.deepEqual(responseBody.catalogPermission.catalogIds, ["4351882411734068"]);
  assert.equal(calls, 1);
});
