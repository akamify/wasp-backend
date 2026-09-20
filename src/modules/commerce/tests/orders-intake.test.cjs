const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, ws } = require("./orders-fixture.cjs");
test("signed intake persists encrypted events before worker processing and creates one local-price order across redelivery", async (t) => {
  const f = fixture(t); await f.receive(); await f.receive();
  assert.equal(f.state.events.length, 1); assert.equal(f.state.orders.length, 0);
  assert.equal(JSON.stringify(f.state.events[0]).includes("Customer private note"), false);
  assert.deepEqual(await f.intake.runOrderIntake(), { processed: 1, failed: 0 });
  await f.receive(); await f.intake.runOrderIntake();
  const order = f.state.orders[0]; assert.equal(f.state.orders.length, 1);
  assert.equal(order.totalPaise, 2400); assert.equal(order.sourceItems[0].unitPricePaise, 1000);
  assert.equal(order.status, "needs_review"); assert.equal(order.reviewedAt, null); assert.equal(order.paymentStatus, "unpaid");
  assert.equal(f.state.products[0].stockReserved, 1); assert.deepEqual(order.warnings, ["price_changed:tea"]);
  assert.equal((await f.service.get(ws, order._id)).customerNote, "Customer private note");
});
test("Commerce rejects missing/invalid signatures even when the surrounding webhook could bypass them", async (t) => {
  const f = fixture(t);
  for (const signature of [undefined, "sha256=" + "0".repeat(64)])
    await assert.rejects(f.intake.receiveOrders({ ...f.signed(), signature }), { statusCode: 401 });
  assert.equal(f.state.events.length, 0);
});
test("intake uses signed bytes rather than a separately supplied parsed body", async (t) => {
  const f = fixture(t); const signed = f.signed();
  const changed = f.body(); changed.entry[0].changes[0].value.messages[0].from = "918888888888";
  await f.intake.receiveOrders({ ...signed, body: changed }); await f.intake.runOrderIntake();
  assert.equal(f.state.orders[0].customerPhone, "919999999999");
});
test("wrong WABA/phone pairs, ambiguous tenants and disabled workspaces never adopt carts", async (t) => {
  const f = fixture(t); const body = f.body(); body.entry[0].id = "999";
  await f.intake.receiveOrders(f.signed(body)); assert.equal(f.state.events.length, 0);
  f.repo.exactTenants = async () => [{ workspaceId: ws }, { workspaceId: ws }];
  await f.receive(); assert.equal(f.state.events.length, 0);
  f.repo.exactTenants = async () => [{ workspaceId: ws }]; f.state.settings.enabled = false;
  await f.receive(); assert.equal(f.state.events.length, 0);
  f.enabled.value = false;
  assert.deepEqual(await f.intake.receiveOrders({ body: f.body() }), { skipped: true });
});
test("catalog mismatch and unknown products enter visible dead-letter state without fabricated orders", async (t) => {
  const f = fixture(t); f.state.products = [];
  await f.receive(); await f.intake.runOrderIntake();
  assert.equal(f.state.orders.length, 0); assert.equal(f.state.events[0].lastError, "unknown_product");
  const events = await f.service.listEvents(ws, { status: "dead_letter", limit: 30 });
  assert.equal(events.items.length, 1); assert.equal(JSON.stringify(events).includes("payloadEnc"), false);
  f.state.catalog.catalogId = "999";
  await f.service.retryEvent(ws, f.state.events[0]._id); await f.intake.runOrderIntake();
  assert.equal(f.state.events[0].lastError, "catalog_binding_unavailable");
});
test("malformed cart is durably dead-lettered and valid sibling messages still process", async (t) => {
  const f = fixture(t); const body = f.body(); const messages = body.entry[0].changes[0].value.messages;
  const invalid = JSON.parse(JSON.stringify(messages[0])); invalid.id = "wamid.invalid"; invalid.order.product_items[0].quantity = 0;
  messages.push(invalid); await f.intake.receiveOrders(f.signed(body)); await f.intake.runOrderIntake();
  assert.equal(f.state.orders.length, 1); assert.equal(f.state.events.filter((e) => e.status === "dead_letter").length, 1);
});
test("failed event completion rolls back order creation and retry creates exactly one order", async (t) => {
  const f = fixture(t); await f.receive();
  const finish = f.repo.finishEvent; let fail = true;
  f.repo.finishEvent = async (event, patch, session) => {
    if (patch.status === "processed" && fail) { fail = false; throw new Error("database failure with private context"); }
    return finish(event, patch, session);
  };
  await f.intake.runOrderIntake(); assert.equal(f.state.orders.length, 0); assert.equal(f.state.events[0].status, "pending");
  assert.equal(f.state.events[0].lastError, "order_processing_failed"); f.advance(60000);
  await f.intake.runOrderIntake(); assert.equal(f.state.orders.length, 1); assert.equal(f.state.events[0].status, "processed");
});
test("test environment is fixed at intake and is not inferred from the available payment gateway", async (t) => {
  const f = fixture(t); f.state.settings.testRecipients = ["919999999999"];
  await f.receive(); f.state.settings.testRecipients = []; await f.intake.runOrderIntake();
  assert.equal(f.state.orders[0].environment, "test");
});
test("catalog/WhatsApp replacement between intake and worker cannot reassign an old order", async (t) => {
  const f = fixture(t); await f.receive(); f.state.binding = false;
  await f.intake.runOrderIntake(); assert.equal(f.state.orders.length, 0); assert.equal(f.state.events[0].lastError, "whatsapp_binding_changed");
});
test("event storage failure rejects receipt so the webhook controller can request provider redelivery", async (t) => {
  const f = fixture(t); f.repo.persistEvent = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(f.receive(), /storage unavailable/); assert.equal(f.state.orders.length, 0);
});
test("worker restart after an expired lease safely resumes the durable cart", async (t) => {
  const f = fixture(t); await f.receive();
  await f.repo.claimEvent(ws, f.state.events[0]._id, "crashed-worker", f.now());
  await f.intake.runOrderIntake(); assert.equal(f.state.orders.length, 0);
  f.advance(120000); await f.intake.runOrderIntake();
  assert.equal(f.state.orders.length, 1); assert.equal(f.state.events[0].status, "processed");
});
