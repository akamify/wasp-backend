require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogSync } = require("../services/catalogSync.service");
const { providerError } = require("../services/metaCatalog.service");
const clone = (value) => structuredClone(value);
function fixture(overrides = {}) {
  const catalog = { _id: "catalog1", workspaceId: "workspace1", catalogId: "333", wabaId: "111", phoneNumberId: "222", graphApiVersion: "v22.0" };
  const product = { _id: "product1", workspaceId: "workspace1", catalogConnectionId: "catalog1", sku: "a", name: "A",
    revision: 1, syncedRevision: 0, syncSubmittedRevision: 0, syncAttempts: 0, syncStatus: "pending", metaProductId: "" };
  let remote = null, posts = 0, productReleased = 0, catalogReleased = 0;
  const repo = {
    findCandidates: async () => ["pending", "accepted"].includes(product.syncStatus) ? [clone(product)] : [],
    claimCatalog: async () => clone(catalog), catalogExists: async () => true,
    holdsCatalog: async () => true, releaseCatalog: async () => { catalogReleased++; },
    claimProducts: async () => [clone(product)], readClaimed: async () => clone(product),
    syncProduct: async (_workspace, expected, _owner, patch) => {
      if (expected.revision !== product.revision || expected.syncSubmittedRevision !== product.syncSubmittedRevision) return null;
      Object.assign(product, patch); return clone(product);
    },
    releaseProducts: async () => { productReleased++; },
  };
  const client = {
    verifyBinding: async () => {},
    lookupProducts: async () => [{ remote: clone(remote) }],
    writeProducts: async (_catalog, products) => {
      posts++;
      assert.equal(product.syncSubmittedRevision, products[0].revision, "submission must be durable before I/O");
      remote = { id: "444", retailer_id: "a", custom_label_4: "aiwizchat:product1", custom_label_3: String(products[0].revision),
        review_status: "approved", visibility: "published" };
      return [{ data: { id: "444" } }];
    },
  };
  const sync = createCatalogSync({ repo, getCredentials: async () => ({ wabaId: "111", phoneNumberId: "222" }),
    createClient: () => client, enabled: () => true, ready: async () => {}, ...overrides });
  return { product, repo, client, sync, setRemote: (value) => { remote = value; },
    counts: () => ({ posts, productReleased, catalogReleased }) };
}
test("accepted write is verified later before becoming synced", async () => {
  const f = fixture();
  await f.sync.run();
  assert.equal(f.product.syncStatus, "accepted");
  assert.equal(f.product.syncedRevision, 0);
  await f.sync.run();
  assert.equal(f.product.syncStatus, "synced");
  assert.equal(f.product.syncedRevision, 1);
  assert.equal(f.product.metaReviewStatus, "approved");
  assert.deepEqual(f.counts(), { posts: 1, productReleased: 2, catalogReleased: 2 });
});
test("timeout or worker crash never blindly repeats a CREATE", async () => {
  const f = fixture();
  let attempts = 0;
  f.client.writeProducts = async () => { attempts++; throw providerError(new Error("timeout"), true); };
  for (let i = 0; i < 12; i++) await f.sync.run();
  assert.equal(attempts, 1);
  assert.equal(f.product.syncSubmittedRevision, 1);
  assert.equal(f.product.syncStatus, "error");
  assert.match(f.product.syncError, /not yet verified/);
});
test("editing during external I/O preserves the newer revision until the old submission resolves", async () => {
  const f = fixture();
  const write = f.client.writeProducts;
  f.client.writeProducts = async (...args) => {
    const result = await write(...args);
    f.product.revision = 2; f.product.name = "Newer"; return result;
  };
  await f.sync.run(); await f.sync.run();
  assert.equal(f.product.name, "Newer");
  assert.equal(f.product.revision, 2);
  assert.equal(f.product.syncedRevision, 1);
  assert.equal(f.product.syncStatus, "pending");
  assert.equal(f.counts().posts, 1);
});
test("unmanaged catalog SKU is never adopted or overwritten", async () => {
  const f = fixture();
  f.setRemote({ id: "444", retailer_id: "a", custom_label_4: "another-system" });
  await f.sync.run();
  assert.equal(f.counts().posts, 0);
  assert.equal(f.product.syncStatus, "error");
  assert.match(f.product.syncError, /unmanaged/);
});
test("pending Meta review polls without resubmission then records approval", async () => {
  const f = fixture();
  await f.sync.run();
  f.setRemote({ id: "444", retailer_id: "a", custom_label_4: "aiwizchat:product1", custom_label_3: "1", review_status: "pending" });
  await f.sync.run(); await f.sync.run();
  assert.equal(f.product.syncStatus, "accepted");
  assert.equal(f.counts().posts, 1);
  f.setRemote({ id: "444", retailer_id: "a", custom_label_4: "aiwizchat:product1", custom_label_3: "1", review_status: "approved" });
  await f.sync.run();
  assert.equal(f.product.syncStatus, "synced");
  assert.equal(f.counts().posts, 1);
});
test("rejected review is visible and never treated as synced", async () => {
  const f = fixture();
  await f.sync.run();
  f.setRemote({ id: "444", retailer_id: "a", custom_label_4: "aiwizchat:product1", custom_label_3: "1", review_status: "rejected" });
  await f.sync.run();
  assert.equal(f.product.syncStatus, "error");
  assert.equal(f.product.metaReviewStatus, "rejected");
});
test("workspace WABA replacement prevents provider access and releases claims", async () => {
  const f = fixture({ getCredentials: async () => ({ wabaId: "other", phoneNumberId: "222" }) });
  await f.sync.run();
  assert.equal(f.counts().posts, 0);
  assert.equal(f.product.syncStatus, "error");
  assert.equal(f.counts().catalogReleased, 1);
  assert.equal(f.counts().productReleased, 1);
});
test("disabled feature never accesses the database or provider", async () => {
  const sync = createCatalogSync({ enabled: () => false, ready: async () => assert.fail("must not run"),
    repo: { findCandidates: async () => assert.fail("must not query") } });
  assert.deepEqual(await sync.run(), { skipped: true });
});

