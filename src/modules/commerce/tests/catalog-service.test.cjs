require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogService } = require("../services/catalog.service");
const workspaceId = "100000000000000000000001";
const catalog = { _id: "200000000000000000000001", workspaceId, catalogId: "333", wabaId: "111", phoneNumberId: "222", revision: 1, active: true };
const credentials = { wabaId: "111", phoneNumberId: "222", accessToken: "test-token" };
const product = { _id: "300000000000000000000001", workspaceId, catalogConnectionId: catalog._id, revision: 2,
  sku: "a", name: "A", condition: "new", taxConfirmed: true, stockReserved: 0, stockOnHand: 1, trackInventory: false,
  syncSubmittedRevision: 0, syncedRevision: 0, archivedAt: null };
function setup(overrides = {}) {
  const repo = { activeCatalog: async (ws, waba) => { assert.equal(ws, workspaceId); assert.equal(waba, "111"); return { ...catalog }; },
    findProduct: async (ws, cat, id) => { assert.equal(ws, workspaceId); assert.equal(cat, catalog._id); return id === product._id ? { ...product } : null; },
    ...overrides };
  return { repo, service: createCatalogService({ repo, getCredentials: async (ws) => { assert.equal(ws, workspaceId); return { ...credentials }; },
    createClient: () => { throw new Error("No provider call expected"); } }) };
}
test("product creation saves locally in its active catalog without a provider request", async () => {
  let saved;
  const { service } = setup({ createProduct: async (data) => { saved = data; return { ...product, ...data }; } });
  const result = await service.createProduct(workspaceId, { sku: "tea", name: "Tea", price: "19.99", taxRateBps: null, taxConfirmed: true });
  assert.equal(saved.workspaceId, workspaceId);
  assert.equal(saved.catalogConnectionId, catalog._id);
  assert.equal(saved.pricePaise, 1999);
  assert.equal(result.syncLeaseOwner, undefined);
});
test("foreign product IDs return not found, stale revisions cannot write", async () => {
  const { service } = setup();
  await assert.rejects(service.getProduct(workspaceId, "foreign-product"), { statusCode: 404 });
  await assert.rejects(service.editProduct(workspaceId, product._id, { revision: 1, name: "Changed" }), { statusCode: 409 });
});
test("an edit during unknown submission preserves verification; archive is immediate", async () => {
  let patch;
  const { service } = setup({
    findProduct: async () => ({ ...product, syncSubmittedRevision: 2, syncedRevision: 1 }),
    updateProduct: async (_ws, current, data) => { patch = data; return { ...current, ...data, revision: 3 }; },
  });
  const result = await service.editProduct(workspaceId, product._id, { revision: 2 }, true);
  assert.ok(patch.archivedAt instanceof Date);
  assert.equal(patch.available, false);
  assert.equal(patch.syncStatus, "accepted");
  assert.equal(result.revision, 3);
});
test("conditional write conflicts surface as conflicts instead of overwriting", async () => {
  const { service } = setup({ updateProduct: async () => null });
  await assert.rejects(service.editProduct(workspaceId, product._id, { revision: 2, name: "Changed" }), { statusCode: 409 });
});
test("pagination returns only the requested bounded page and continuation cursor", async () => {
  const { service } = setup({ listProducts: async (_ws, cat, query) => {
    assert.equal(cat, catalog._id); assert.equal(query.limit, 1);
    return [{ ...product }, { ...product, _id: "older" }];
  } });
  const result = await service.listProducts(workspaceId, { limit: 1, archived: false });
  assert.equal(result.products.length, 1);
  assert.equal(result.nextCursor, product._id);
});
test("first connection refuses a populated catalog and does not create local records", async () => {
  const service = createCatalogService({
    repo: { activeCatalog: async () => null, historicalCatalog: async () => null, createCatalog: async () => assert.fail("must not bind") },
    getCredentials: async () => credentials, createClient: () => ({
      ownerBusiness: async () => ({ id: "444" }), verifyOwner: async () => {},
      verifyEmptyCatalog: async () => { throw Object.assign(new Error("populated"), { statusCode: 409 }); },
      linkCatalog: async () => assert.fail("populated catalog must not be linked"),
    }),
  });
  await assert.rejects(service.bindCatalog(workspaceId, { catalogId: "333" }), { statusCode: 409 });
});
test("new binding rechecks WhatsApp account after external verification", async () => {
  let calls = 0;
  const service = createCatalogService({
    repo: { activeCatalog: async () => null, historicalCatalog: async () => null, createCatalog: async () => assert.fail("must not bind") },
    getCredentials: async () => ++calls === 1 ? credentials : { ...credentials, wabaId: "other" },
    createClient: () => ({ ownerBusiness: async () => ({ id: "444" }), verifyOwner: async () => {},
      verifyEmptyCatalog: async () => {}, linkCatalog: async () => {},
      inspectCatalog: async () => ({ empty: true, businessId: "444" }), version: "v22.0" }),
  });
  await assert.rejects(service.bindCatalog(workspaceId, { catalogId: "333" }), { statusCode: 409 });
});
test("new binding verifies ownership and emptiness before linking the catalog to the WABA", async () => {
  const calls = [];
  const created = { ...catalog, businessId: "444", graphApiVersion: "v22.0", status: "connected" };
  const service = createCatalogService({
    repo: { activeCatalog: async () => null, historicalCatalog: async () => null,
      createCatalog: async (fields) => ({ ...created, ...fields }) },
    getCredentials: async () => credentials,
    createClient: () => ({ version: "v22.0",
      ownerBusiness: async () => { calls.push("business"); return { id: "444" }; },
      verifyOwner: async (id, businessId) => { calls.push(`owner:${id}:${businessId}`); },
      verifyEmptyCatalog: async (id) => { calls.push(`empty:${id}`); },
      linkCatalog: async (id) => { calls.push(`link:${id}`); },
      inspectCatalog: async (id) => { calls.push(`inspect:${id}`); return { businessId: "444", empty: true,
        catalogVisible: true, cartEnabled: true }; },
    }),
  });
  const result = await service.bindCatalog(workspaceId, { catalogId: "333" });
  assert.deepEqual(calls, ["business", "owner:333:444", "empty:333", "link:333", "inspect:333"]);
  assert.equal(result.catalogId, "333");
});
test("old phone binding blocks product changes but permits local disconnect", async () => {
  let disconnected = false, released = false;
  const service = createCatalogService({
    repo: { activeCatalog: async () => catalog, claimCatalog: async () => catalog,
      updateCatalog: async (_ws, _id, _owner, _rev, patch) => { disconnected = !patch.active; return { ...catalog, ...patch }; },
      releaseCatalog: async () => { released = true; } },
    getCredentials: async () => ({ ...credentials, phoneNumberId: "999" }),
    createClient: () => assert.fail("local disconnect must not change remote settings"),
  });
  await assert.rejects(service.createProduct(workspaceId, {}), { statusCode: 409 });
  await service.changeCatalog(workspaceId, { revision: 1 }, "disconnect");
  assert.equal(disconnected, true); assert.equal(released, true);
});
