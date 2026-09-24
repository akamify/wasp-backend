require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSetupService } = require("../services/catalogSetup.service");
const { createCatalogClient } = require("../services/metaCatalog.service");
const { parse, catalogCreate } = require("../validators/catalog.validators");
const input = { name: "Menu", confirmOwnership: true };
function fixture() {
  let row, creates = 0, locked = false;
  const credentials = {
    wabaId: "111",
    phoneNumberId: "222",
    grantedScopes: ["whatsapp_business_management", "whatsapp_business_messaging", "catalog_management", "business_management"],
    catalogTargetIds: ["444"],
  };
  const repo = {
    read: async () => row,
    ensure: async (ws, fields) => row ||= { ...fields, workspaceId: ws, state: "ready", catalogId: "" },
    claim: async () => { if (locked) return null; locked = true; return row; },
    save: async (_ws, _waba, _owner, patch) => row = { ...row, ...patch },
    release: async () => { locked = false; },
  };
  const client = { ownerBusiness: async () => ({ id: "333" }), linkedCatalogs: async () => ({ catalogs: [] }),
    createOwnedCatalog: async () => { creates++; return "444"; }, verifyOwner: async () => {}, verifyEmptyCatalog: async () => {}, linkCatalog: async () => {} };
  const catalogService = { getCatalog: async () => null, bindCatalog: async (_ws, data, options) => {
    assert.deepEqual(options, { requireCatalogTarget: false });
    return { id: "local", ...data };
  } };
  const service = createSetupService({ repo, createClient: () => client, getCredentials: async () => ({ ...credentials }), catalogService });
  return { service, client, repo, credentials, catalogService, creates: () => creates, row: () => row };
}
test("creates once, saves ID before linking and resumes a failed link", async () => {
  const f = fixture();
  f.client.linkCatalog = async () => { assert.equal(f.row().catalogId, "444"); throw new Error("link unavailable"); };
  await assert.rejects(f.service.create("ws", input));
  assert.equal(f.row().state, "created");
  f.client.linkCatalog = async () => {};
  assert.equal((await f.service.create("ws", input)).catalogId, "444");
  assert.equal(f.creates(), 1);
  assert.equal(f.row().state, "connected");
});
test("unknown creation result is never automatically recreated; ownership-checked ID recovers", async () => {
  const f = fixture(); let calls = 0;
  f.client.createOwnedCatalog = async () => { calls++; throw Object.assign(new Error("timeout"), { ambiguous: true }); };
  await assert.rejects(f.service.create("ws", input));
  await assert.rejects(f.service.create("ws", input), /uncertain/);
  assert.equal(calls, 1);
  f.client.verifyOwner = async (id, business) => { assert.equal(id, "555"); assert.equal(business, "333"); };
  assert.equal((await f.service.create("ws", { ...input, recoveryCatalogId: "555" })).catalogId, "555");
});
test("definite provider rejection permits a safe creation retry", async () => {
  const f = fixture();
  f.client.createOwnedCatalog = async () => { throw Object.assign(new Error("permission"), { ambiguous: false }); };
  await assert.rejects(f.service.create("ws", input));
  assert.equal(f.row().state, "ready");
});
test("existing remote binding and local binding block creation", async () => {
  const f = fixture();
  f.client.linkedCatalogs = async () => ({ catalogs: [{ id: "999" }] });
  await assert.rejects(f.service.create("ws", input), /already has/);
  f.catalogService.getCatalog = async () => ({ catalogId: "999" });
  await assert.rejects(f.service.create("ws", input), /already connected/);
  assert.equal(f.creates(), 0);
});
test("concurrent setup cannot issue two create calls", async () => {
  const f = fixture(); let resume;
  f.client.createOwnedCatalog = () => new Promise((resolve) => { resume = resolve; });
  const first = f.service.create("ws", input);
  while (!resume) await new Promise(setImmediate);
  await assert.rejects(f.service.create("ws", input), /in progress/);
  resume("444"); await first;
});
test("changed phone cannot resume setup or bind a created catalog", async () => {
  const f = fixture();
  f.client.createOwnedCatalog = async () => { f.credentials.phoneNumberId = "999"; return "444"; };
  await assert.rejects(f.service.create("ws", input), /connection changed/);
  await assert.rejects(f.service.create("ws", input), /another WhatsApp/);
});
test("request validation rejects whitespace, foreign fields and missing consent", () => {
  for (const data of [{ ...input, name: "   " }, { ...input, workspaceId: "other" }, { name: "Menu" }, { ...input, recoveryCatalogId: "bad" }]) {
    assert.throws(() => parse(catalogCreate, data), { statusCode: 400 });
  }
  assert.equal(parse(catalogCreate, input).name, "Menu");
});
test("Meta create and link use verified business/WABA endpoints and form encoding", async () => {
  const calls = []; let linked = false;
  const client = createCatalogClient({ accessToken: "test", wabaId: "111", phoneNumberId: "222" }, { client: {
    get: async (path) => ({ data: path === "/111" ? { id: "111", owner_business_info: { id: "333" } }
      : path === "/333/owned_product_catalogs" ? { data: [{ id: "444", vertical: "commerce" }] }
      : path === "/999/owned_product_catalogs" ? { data: [] }
      : { data: linked ? [{ id: "444", name: "Menu" }] : [] } }),
    post: async (path, body) => { calls.push([path, Object.fromEntries(body)]); if (path === "/111/product_catalogs") linked = true; return { data: { id: "444" } }; },
  } });
  assert.equal((await client.ownerBusiness()).id, "333");
  assert.equal(await client.createOwnedCatalog("333", "Menu & drinks"), "444");
  await client.verifyOwner("444", "333");
  await assert.rejects(client.verifyOwner("444", "999"), { statusCode: 409 });
  await client.linkCatalog("444"); await client.linkCatalog("444");
  assert.deepEqual(calls, [["/333/owned_product_catalogs", { name: "Menu & drinks", vertical: "commerce" }], ["/111/product_catalogs", { catalog_id: "444" }]]);
});

test("setup persistence pins workspace, primary key, lease owner and unexpired lease", async (t) => {
  const { CommerceCatalogSetup: Model } = require("@infra/database/CommerceCatalogSetup");
  const repo = require("../repositories/catalogSetup.repository");
  const ws = "100000000000000000000001";
  const calls = [];
  t.mock.method(Model, "findOneAndUpdate", (filter, update, options) => {
    calls.push({ filter, update, options }); return { lean: async () => null };
  });
  await repo.claim(ws, "111", "owner");
  await repo.save(ws, "111", "owner", { catalogId: "444" });
  for (const { filter } of calls) {
    assert.equal(String(filter.$and[0].workspaceId), ws);
    assert.equal(filter.$and[1]._id, `${ws}:111`);
  }
  assert.ok(calls[0].filter.$or[1].leaseUntil.$lte instanceof Date);
  assert.equal(calls[1].filter.leaseOwner, "owner");
  assert.ok(calls[1].filter.leaseUntil.$gt instanceof Date);
  assert.equal(calls[1].options.runValidators, true);
  assert.throws(() => repo.read("invalid", "111"));
  const doc = new Model({ _id: `${ws}:111`, workspaceId: ws, wabaId: "111", phoneNumberId: "222", businessId: "333", name: "Menu" });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.state, "ready");
});

test("lease loss before creation prevents a remote write and status hides internal lease fields", async () => {
  const f = fixture();
  f.repo.save = async () => null;
  await assert.rejects(f.service.create("ws", input), /setup changed/);
  assert.equal(f.creates(), 0);
  assert.deepEqual(await f.service.status("ws"), {
    setup: { name: "Menu", catalogId: "", state: "ready", activePhoneMatches: true },
    capabilities: { connectExistingCatalog: true, createCatalog: true },
  });
});

test("catalog creation is gated while existing catalog connection remains available", async () => {
  const f = fixture();
  f.credentials.grantedScopes = ["whatsapp_business_management", "whatsapp_business_messaging", "catalog_management"];
  f.client.ownerBusiness = async () => assert.fail("missing creation permission must fail before Meta calls");
  assert.deepEqual(await f.service.status("ws"), {
    setup: null,
    capabilities: { connectExistingCatalog: true, createCatalog: false },
  });
  await assert.rejects(f.service.create("ws", input), (error) => {
    assert.equal(error.statusCode, 403);
    assert.deepEqual(error.details.missingScopes, ["business_management"]);
    assert.match(error.details.alternative, /Find linked catalogs/);
    return true;
  });
  assert.equal(f.row(), undefined);
  assert.equal(f.creates(), 0);
});

test("existing catalog connection remains gated until Meta shares a catalog asset target", async () => {
  const f = fixture();
  f.credentials.catalogTargetIds = [];
  assert.deepEqual(await f.service.status("ws"), {
    setup: null,
    capabilities: { connectExistingCatalog: false, createCatalog: true },
  });
});

test("a completed setup replay returns the connected catalog without another provider write", async () => {
  const f = fixture();
  const catalog = await f.service.create("ws", input);
  f.catalogService.getCatalog = async () => catalog;
  f.client.ownerBusiness = async () => assert.fail("completed setup needs no provider request");
  assert.deepEqual(await f.service.create("ws", input), catalog);
  assert.equal(f.creates(), 1);
  f.credentials.phoneNumberId = "999";
  await assert.rejects(f.service.create("ws", input), /already connected/);
});

test("invalid recovery cannot poison the saved setup or link a populated catalog", async () => {
  const f = fixture();
  f.client.createOwnedCatalog = async () => { throw new Error("uncertain"); };
  await assert.rejects(f.service.create("ws", input));
  f.client.verifyEmptyCatalog = async () => { throw new Error("not empty"); };
  f.client.linkCatalog = async () => assert.fail("must not link");
  await assert.rejects(f.service.create("ws", { ...input, recoveryCatalogId: "555" }), /not empty/);
  assert.equal(f.row().catalogId, "");
  assert.equal(f.row().state, "creating");
});

test("a new external binding blocks creation retry after a definite rejection", async () => {
  const f = fixture();
  f.client.createOwnedCatalog = async () => { throw Object.assign(new Error("denied"), { ambiguous: false }); };
  await assert.rejects(f.service.create("ws", input));
  f.client.linkedCatalogs = async () => ({ catalogs: [{ id: "999" }] });
  f.client.createOwnedCatalog = async () => assert.fail("must not create");
  await assert.rejects(f.service.create("ws", input), /already has/);
});

test("Meta recovery checks all products and rejects malformed or populated catalogs", async () => {
  let data = [], parameters;
  const client = createCatalogClient({ accessToken: "test", wabaId: "111", phoneNumberId: "222" }, { client: {
    get: async (path, options) => { assert.equal(path, "/444/products"); parameters = options.params; return { data: { data } }; },
  } });
  await client.verifyEmptyCatalog("444");
  assert.equal(parameters.return_only_approved_products, false);
  assert.equal(parameters.limit, 1);
  data = [{ id: "555" }];
  await assert.rejects(client.verifyEmptyCatalog("444"), { statusCode: 409 });
  data = null;
  await assert.rejects(client.verifyEmptyCatalog("444"), { statusCode: 502 });
});
