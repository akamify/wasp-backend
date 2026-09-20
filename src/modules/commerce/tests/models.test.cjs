require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const models = require("../models");
const { byWorkspace } = require("../repositories/scope");
const { ROLE_PERMISSIONS, WORKSPACE_PERMISSIONS } = require("@modules/workspaces/constants/workspacePermissions");
const { COMMERCE_PERMISSIONS } = require("../constants/permissions");
const id = () => new mongoose.Types.ObjectId();

test("every commerce model requires an immutable workspace and disables implicit index creation", () => {
  assert.equal(Object.keys(models).length, 12);
  for (const Model of Object.values(models)) {
    assert.equal(Model.schema.path("workspaceId").options.required, true);
    assert.equal(Model.schema.path("workspaceId").options.immutable, true);
    assert.equal(Model.schema.options.autoIndex, false);
    assert.equal(Model.schema.options.autoCreate, false);
    assert.equal(Model.schema.options.strict, "throw");
    assert.ok(new Model().validateSync().errors.workspaceId);
  }
});
test("workspace filter requires a scalar ID and retains tenant constraint against override or OR filters", () => {
  const workspaceId = id();
  const other = id();
  const filter = byWorkspace(workspaceId, { workspaceId: other, $or: [{ workspaceId: other }, {}] });
  assert.equal(String(filter.$and[0].workspaceId), String(workspaceId));
  assert.equal(String(filter.$and[1].workspaceId), String(other));
  for (const value of [null, undefined, "", "bad", {}, { $ne: null }, 123, []]) {
    assert.throws(() => byWorkspace(value), TypeError);
  }
  for (const value of [null, [], "bad", new Date()]) assert.throws(() => byWorkspace(workspaceId, value), TypeError);
});
test("gateway schema supports manual and OAuth while withholding secrets from JSON", () => {
  for (const authType of ["api_keys", "oauth"]) {
    const doc = new models.CommerceGatewayConnection({ workspaceId: id(), environment: "test", authType, createdBy: "user-test",
      keySecretEnc: "encrypted-test-secret", accessTokenEnc: "encrypted-test-token", webhookSecretEnc: "encrypted-test-webhook",
    });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.nativePaymentStatus, "unverified");
    assert.equal(doc.webhookStatus, "needs_setup");
    assert.equal(doc.identityVerified, false);
    assert.equal(doc.keySecretEnc, "encrypted-test-secret");
    assert.equal(JSON.stringify(doc).includes("encrypted-test"), false);
    assert.equal(doc.toJSON().authType, authType);
  }
});
test("all explicitly selected hidden fields remain excluded from document JSON", () => {
  for (const Model of Object.values(models)) {
    const doc = new Model({ workspaceId: id() });
    Model.schema.eachPath((path, definition) => {
      if (definition.options.select === false) doc.set(path, "sensitive-test-marker");
    });
    assert.equal(JSON.stringify(doc).includes("sensitive-test-marker"), false, Model.modelName);
  }
});
test("commerce starts disabled and test/live are separate explicit gateway environments", () => {
  const settings = new models.CommerceSettings({ workspaceId: id() });
  assert.equal(settings.enabled, false);
  assert.equal(settings.liveCheckoutEnabled, false);
  assert.equal(settings.reservationMinutes, 30);
  const connection = { workspaceId: id(), authType: "api_keys", createdBy: "user-test" };
  assert.ok(new models.CommerceGatewayConnection(connection).validateSync().errors.environment);
  for (const environment of ["test", "live"]) {
    assert.equal(new models.CommerceGatewayConnection({ ...connection, environment }).validateSync(), undefined);
  }
  const bad = new models.CommerceGatewayConnection({ ...connection, environment: "production" });
  assert.ok(bad.validateSync().errors.environment);
});
function product(overrides = {}) {
  return new models.CommerceProduct({ workspaceId: id(), catalogConnectionId: id(), sku: "meal",
    name: "Meal", imageUrl: "https://example.com/meal.jpg", productUrl: "https://example.com/meal",
    pricePaise: 11800, ...overrides });
}
test("product schema rejects fractional or negative paise and inventory", () => {
  assert.equal(product().validateSync(), undefined);
  for (const field of ["pricePaise", "stockOnHand", "stockReserved"]) {
    for (const value of [-1, 0.5, Infinity]) assert.ok(product({ [field]: value }).validateSync().errors[field]);
  }
  for (const value of [-1, 1800.5, 10001]) assert.ok(product({ taxRateBps: value }).validateSync().errors.taxRateBps);
});
test("unknown fields fail instead of being silently persisted", () => {
  assert.throws(() => product({ merchantGatewaySecret: "bad" }), mongoose.Error.StrictModeError);
});
test("order snapshots require at least one distinct SKU and valid quantities and tax", () => {
  const item = { productId: id(), sku: "meal", quantity: 1, unitPricePaise: 11800, grossPaise: 11800, taxRateBps: 1800, includedTaxPaise: 1800 };
  const fields = { workspaceId: id(), catalogConnectionId: id(), wabaId: "waba-test", phoneNumberId: "phone-test",
    inboundMessageId: "wamid-test", orderNumber: "ORDER-TEST", customerPhone: "910000000000", items: [item] };
  assert.equal(new models.CommerceOrder(fields).validateSync(), undefined);
  for (const items of [[], [item, item], [{ ...item, quantity: 0 }], [{ ...item, quantity: 0.5 }], [{ ...item, taxRateBps: -1 }], [{ ...item, includedTaxPaise: 0.5 }]]) {
    assert.ok(new models.CommerceOrder({ ...fields, items }).validateSync());
  }
});
test("role additions keep gateway and payment management owner/admin only by default", () => {
  for (const role of ["owner", "admin"]) for (const permission of COMMERCE_PERMISSIONS) assert.ok(ROLE_PERMISSIONS[role].includes(permission));
  for (const role of ["manager", "agent", "viewer"]) {
    assert.equal(ROLE_PERMISSIONS[role].includes("commerce.gateway.manage"), false);
    assert.equal(ROLE_PERMISSIONS[role].includes("commerce.payments.manage"), false);
  }
  assert.ok(ROLE_PERMISSIONS.manager.includes("commerce.orders.manage"));
  assert.ok(ROLE_PERMISSIONS.agent.includes("commerce.messages.send"));
  assert.equal(ROLE_PERMISSIONS.agent.includes("commerce.orders.manage"), false);
  assert.ok(ROLE_PERMISSIONS.viewer.filter((key) => key.startsWith("commerce.")).every((key) => key.endsWith(".view")));
  assert.equal(new Set(WORKSPACE_PERMISSIONS).size, WORKSPACE_PERMISSIONS.length);
  assert.ok(ROLE_PERMISSIONS.owner.includes("plan.manage"));
  assert.equal(ROLE_PERMISSIONS.admin.includes("plan.manage"), false);
});

