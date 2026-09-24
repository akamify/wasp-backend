require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogClient, providerError } = require("../services/metaCatalog.service");
const credentials = { accessToken: "test-token", wabaId: "111", phoneNumberId: "222", graphApiVersion: "v22.0" };
const product = { _id: "local1", sku: "SKU & 1", name: "Tea & Milk", description: "A drink", condition: "new",
  revision: 1, pricePaise: 100, imageUrl: "https://example.com/a", productUrl: "https://example.com/b", available: true };

test("Meta binding uses the active WABA, follows cursors without following external next URLs", async () => {
  const calls = [];
  const client = createCatalogClient(credentials, { client: { get: async (path, options) => {
    calls.push({ path, options });
    return { data: options.params.after ? { data: [{ id: "333", name: "Catalog" }] }
      : { data: [], paging: { next: "https://untrusted.example/token", cursors: { after: "cursor2" } } } };
  } } });
  await client.verifyBinding("333");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, "/111/product_catalogs");
  assert.equal(calls[1].options.params.after, "cursor2");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[0].options.maxRedirects, 0);
});
test("catalog lookup is scoped to retailer ID and never treats missing or ambiguous data as ownership", async () => {
  let request;
  const client = createCatalogClient(credentials, { client: { post: async (_path, body) => {
    request = JSON.parse(body.get("batch"))[0];
    return { data: [{ code: 200, body: JSON.stringify({ data: [{ id: "444", retailer_id: "other" }] }) }] };
  } } });
  const [result] = await client.lookupProducts("333", [product]);
  assert.equal(result.error.statusCode, 409);
  const query = new URLSearchParams(request.relative_url.split("?")[1]);
  assert.deepEqual(JSON.parse(query.get("filter")), { retailer_id: { eq: product.sku } });
  assert.equal(query.get("return_only_approved_products"), "false");
});
test("Graph batch creation encodes values and explicitly disables upsert", async () => {
  let request;
  const client = createCatalogClient(credentials, { client: { post: async (path, body) => {
    assert.equal(path, "/");
    request = JSON.parse(body.get("batch"))[0];
    return { data: [{ code: 200, body: '{"id":"444"}' }] };
  } } });
  const [result] = await client.writeProducts("333", [product]);
  assert.equal(result.data.id, "444");
  assert.equal(request.relative_url, "333/products");
  const body = new URLSearchParams(request.body);
  assert.equal(body.get("allow_upsert"), "false");
  assert.equal(body.get("price"), "100");
  assert.equal(body.get("name"), "Tea & Milk");
  assert.equal(body.get("retailer_id"), "SKU & 1");
});
test("malformed and timed-out writes remain ambiguous and provider secrets are not exposed", async () => {
  const client = createCatalogClient(credentials, { client: { post: async () => ({ data: [{ code: 200, body: "bad" }] }) } });
  const [result] = await client.writeProducts("333", [product]);
  assert.equal(result.error.ambiguous, true);
  const raw = Object.assign(new Error("secret-token"), { response: { status: 429, data: { error: { message: "secret-token", code: 4 } }, headers: { "retry-after": "60" } } });
  const safe = providerError(raw, true);
  assert.equal(safe.retryable, true);
  assert.equal(safe.retryAfterMs, 60000);
  assert.equal(safe.message.includes("secret-token"), false);
  assert.equal(safe.ambiguous, false);
  assert.equal(providerError(new Error("timeout"), true).ambiguous, true);
});
test("phone commerce settings are read back after successful update", async () => {
  const calls = [];
  const client = createCatalogClient(credentials, { client: {
    post: async (path, _body, options) => { calls.push({ path, options }); return { data: { success: true } }; },
    get: async () => ({ data: { data: [{ is_catalog_visible: true, is_cart_enabled: false }] } }),
  } });
  assert.deepEqual(await client.updateSettings({ catalogVisible: true, cartEnabled: false }), { catalogVisible: true, cartEnabled: false });
  assert.equal(calls[0].path, "/222/whatsapp_commerce_settings");
  assert.equal(calls[0].options.params.is_catalog_visible, true);
});

test("code 100 diagnostics identify the failed operation without exposing provider text or secrets", async () => {
  const error = { response: { status: 400, data: { error: { code: 100, error_subcode: 33,
    fbtrace_id: "trace_123", message: "Unsupported post request. Object secret-token cannot be loaded" } } } };
  const client = createCatalogClient(credentials, { client: { post: async () => { throw error; } } });
  await assert.rejects(client.createOwnedCatalog("333", "Menu"), (failure) => {
    assert.equal(failure.statusCode, 422);
    assert.equal(failure.details.operation, "create_catalog");
    assert.equal(failure.details.providerSubcode, 33);
    assert.equal(failure.details.providerTraceId, "trace_123");
    assert.equal(failure.details.providerReason, "object_unavailable_or_operation_unsupported");
    assert.equal(JSON.stringify(failure).includes("secret-token"), false);
    return true;
  });
  const safe = providerError({ response: { status: 400, data: { error: { code: 100,
    message: "Tried accessing nonexisting field (owner_business_info) on node secret-token" } } } });
  assert.equal(safe.details.providerField, "owner_business_info");
  assert.equal(safe.details.providerReason, "unsupported_field");
});

test("catalog access and WABA link failures return actionable bounded errors", async () => {
  const providerFailure = { response: { status: 400, data: { error: { code: 100, error_subcode: 33,
    message: "Unsupported request for object secret-token" } } } };
  const reads = createCatalogClient(credentials, { client: { get: async () => { throw providerFailure; } } });
  await assert.rejects(reads.verifyCatalogObject("333"), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details.operation, "read_catalog_object");
    assert.equal(error.details.diagnosticCode, "catalog_object_unavailable");
    assert.equal(error.details.requestedCatalogId, "333");
    assert.match(error.message, /cannot load this catalog object/);
    return true;
  });
  await assert.rejects(reads.verifyEmptyCatalog("333"), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details.operation, "read_catalog_products");
    assert.equal(error.details.diagnosticCode, "catalog_products_edge_unavailable");
    assert.equal(error.details.requestedCatalogId, "333");
    assert.match(error.message, /cannot read its products/);
    assert.equal(JSON.stringify(error).includes("secret-token"), false);
    return true;
  });
  const links = createCatalogClient(credentials, { client: {
    get: async () => ({ data: { data: [] } }),
    post: async () => { throw providerFailure; },
  } });
  await assert.rejects(links.linkCatalog("333"), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.details.operation, "link_catalog");
    assert.match(error.message, /same Business Portfolio/);
    return true;
  });
});

test("catalog object probe requires Meta to echo the requested catalog identity", async () => {
  const client = createCatalogClient(credentials, { client: { get: async () => ({ data: { id: "999" } }) } });
  await assert.rejects(client.verifyCatalogObject("333"), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.details.diagnosticCode, "catalog_identity_mismatch");
    assert.equal(error.details.requestedCatalogId, "333");
    return true;
  });
});
