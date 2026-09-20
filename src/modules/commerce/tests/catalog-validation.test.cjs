require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const schemas = require("../validators/catalog.validators");
const { productPatch, remoteProductData, ownsRemote, retryAt } = require("../domain/catalog");
const input = () => ({ sku: "meal", name: "Meal", description: "A meal", condition: "new",
  imageUrl: "https://example.com/meal.jpg", productUrl: "https://example.com/meal",
  price: "118.00", taxConfirmed: true, taxRateBps: 1800 });

test("product API requires explicit tax and condition and accepts exact decimal prices", () => {
  const parsed = schemas.parse(schemas.createProduct, input());
  assert.equal(productPatch(parsed).pricePaise, 11800);
  assert.equal(parsed.stockOnHand, 0);
  for (const patch of [{ price: 118 }, { price: "1.005" }, { stockOnHand: 1.5 },
    { taxConfirmed: false }, { taxRateBps: -1 }, { condition: "unknown" },
    { workspaceId: "other" }, { stockReserved: 1 }, { syncStatus: "synced" }]) {
    assert.throws(() => schemas.parse(schemas.createProduct, { ...input(), ...patch }), { statusCode: 400 });
  }
  for (const field of ["taxRateBps", "taxConfirmed", "condition"]) {
    const data = input(); delete data[field];
    assert.throws(() => schemas.parse(schemas.createProduct, data), { statusCode: 400 });
  }
});
test("catalog URLs reject credentials, local addresses, non-HTTPS and unexpected ports", () => {
  for (const imageUrl of ["http://example.com/a", "https://u:p@example.com/a", "https://127.0.0.1/a",
    "https://[::1]/a", "https://localhost/a", "https://test.local/a", "https://example.com:123/a", "javascript:alert(1)"]) {
    assert.throws(() => schemas.parse(schemas.createProduct, { ...input(), imageUrl }), { statusCode: 400 });
  }
});
test("immutable API fields and unbounded pagination are rejected", () => {
  for (const patch of [{ revision: 1, sku: "changed" }, { revision: 1, catalogConnectionId: "other" },
    { name: "changed" }, { revision: 0, name: "changed" }, { revision: 1 }]) {
    assert.throws(() => schemas.parse(schemas.updateProduct, patch), { statusCode: 400 });
  }
  assert.deepEqual(schemas.parse(schemas.listQuery, { limit: "10", archived: "true" }, true), { limit: 10, archived: true });
  assert.throws(() => schemas.parse(schemas.listQuery, { limit: 101 }, true), { statusCode: 400 });
  assert.throws(() => schemas.parse(schemas.listQuery, { cursor: { $ne: null } }, true), { statusCode: 400 });
  assert.throws(() => schemas.parse(schemas.catalogBind, { catalogId: "123", confirmDedicatedCatalog: false }), { statusCode: 400 });
});
test("stock updates cannot invalidate reservations and tax changes require confirmation", () => {
  const current = { taxConfirmed: true, trackInventory: true, stockOnHand: 10, stockReserved: 4 };
  assert.throws(() => productPatch({ stockOnHand: 3 }, current), { statusCode: 409 });
  assert.throws(() => productPatch({ trackInventory: false }, current), { statusCode: 409 });
  assert.throws(() => productPatch({ taxRateBps: 500 }, current), { statusCode: 400 });
  assert.equal(productPatch({ taxRateBps: null, taxConfirmed: true }, current).taxRateBps, null);
});
test("remote payload preserves integer money and ownership markers, archives stop availability", () => {
  const product = { _id: "local1", sku: "meal", name: "Meal", description: "Meal", condition: "used",
    imageUrl: "https://example.com/a.jpg", productUrl: "https://example.com/a", revision: 7,
    pricePaise: 11800, available: true, trackInventory: true, stockOnHand: 4, stockReserved: 4 };
  const data = remoteProductData(product);
  assert.equal(data.price, 11800); assert.equal(data.currency, "INR"); assert.equal(data.condition, "used");
  assert.equal(data.availability, "out of stock");
  assert.equal(data.custom_label_3, "7");
  assert.equal(ownsRemote(product, { ...data, id: "123" }), true);
  assert.equal(ownsRemote({ ...product, _id: "other" }, data), false);
  assert.equal(remoteProductData({ ...product, archivedAt: new Date() }).visibility, "staging");
  const now = new Date("2026-09-10T00:00:00Z");
  assert.ok(retryAt(100, now).getTime() - now.getTime() <= 3600000);
});

