require("module-alias/register");
const crypto = require("node:crypto");
const { CommerceOrder: Order } = require("@infra/database/CommerceOrder");
const { CommerceEvent: Event } = require("@infra/database/CommerceEvent");
const { createOrderIntake } = require("../services/orderIntake.service");
const { createOrdersService } = require("../services/orders.service");
const ws = "100000000000000000000001", otherWs = "100000000000000000000002", catalogId = "300000000000000000000001", productId = "400000000000000000000001";
const address = { name: "Test Customer", phone: "919999999999", line1: "Example address", city: "Delhi", state: "Delhi", postalCode: "110001", country: "IN" };
function fixture(t) {
  const previous = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  t.after(() => previous === undefined ? delete process.env.CREDENTIALS_ENCRYPTION_KEY : process.env.CREDENTIALS_ENCRYPTION_KEY = previous);
  let time = new Date("2026-09-10T12:00:00Z"), tail = Promise.resolve();
  const now = () => new Date(time);
  const state = { orders: [], events: [], sessions: [], active: true, binding: true,
    settings: { enabled: true, pickupEnabled: true, deliveryEnabled: true, pickupInstructions: "Collect at the counter", testRecipients: [], revision: 1 },
    catalog: { _id: catalogId, workspaceId: ws, wabaId: "123", phoneNumberId: "456", catalogId: "789", active: true },
    products: [{ _id: productId, workspaceId: ws, catalogConnectionId: catalogId, sku: "tea", name: "Tea", pricePaise: 1200,
      revision: 2, available: true, archivedAt: null, taxConfirmed: true, taxRateBps: null, stockOnHand: 10, stockReserved: 1, trackInventory: true }],
  };
  const equal = (a, b) => String(a) === String(b);
  const repo = {
    transaction: (work) => {
      const result = tail.then(async () => {
        const snapshot = { orders: [...state.orders], events: [...state.events], sessions: [...state.sessions] };
        try { return await work({ testTransaction: true }); } catch (error) { Object.assign(state, snapshot); throw error; }
      });
      tail = result.catch(() => {}); return result;
    },
    exactTenants: async (waba, phone) => state.binding && waba === "123" && phone === "456" ? [{ workspaceId: ws }] : [],
    connectionMatches: async (workspace, waba, phone) => equal(workspace, ws) && state.binding && waba === "123" && phone === "456",
    workspaceActive: async (workspace) => equal(workspace, ws) && state.active,
    settings: async (workspace) => equal(workspace, ws) ? state.settings : null,
    saveSettings: async (_workspace, revision, patch) => {
      if (revision !== state.settings.revision) return null;
      state.settings = { ...state.settings, ...patch, revision: revision + 1 }; return state.settings;
    },
    catalog: async (workspace, filter) => equal(workspace, ws) && state.catalog.active
      && Object.entries(filter).every(([key, value]) => equal(state.catalog[key], value)) ? state.catalog : null,
    products: async (workspace, catalog, skus) => state.products.filter((p) => equal(p.workspaceId, workspace) && equal(p.catalogConnectionId, catalog) && skus.includes(p.sku)),
    order: async (workspace, id) => state.orders.find((o) => equal(o.workspaceId, workspace) && equal(o._id, id)),
    existingOrder: async (workspace, waba, inbound) => state.orders.find((o) => equal(o.workspaceId, workspace) && o.wabaId === waba && o.inboundMessageId === inbound),
    createOrder: async (fields) => {
      const doc = new Order(fields); const error = doc.validateSync(); if (error) throw error;
      const order = doc.toObject(); state.orders.push(order); return order;
    },
    updateOrder: async (workspace, id, revision, patch) => {
      const index = state.orders.findIndex((o) => equal(o.workspaceId, workspace) && equal(o._id, id) && o.revision === revision
        && ["needs_review", "needs_details"].includes(o.status) && o.paymentStatus === "unpaid" && !o.activeAttemptId && !o.paidAttemptId);
      if (index < 0) return null;
      state.orders[index] = { ...state.orders[index], ...patch, revision: revision + 1 }; return state.orders[index];
    },
    listOrders: async (workspace, { environment, status, limit }) => state.orders.filter((o) => equal(o.workspaceId, workspace) && o.environment === environment && (!status || o.status === status)).slice(0, limit + 1),
    persistEvent: async (fields) => {
      const old = state.events.find((e) => equal(e.workspaceId, fields.workspaceId) && e.eventKey === fields.eventKey);
      if (old) return old;
      const event = new Event(fields).toObject(); state.events.push(event); return event;
    },
    eventCandidates: async (at) => state.events.filter((e) => e.nextAttemptAt <= at && (e.status === "pending" || (e.status === "processing" && e.leaseUntil <= at))).slice(0, 20),
    claimEvent: async (workspace, id, owner, at) => {
      const index = state.events.findIndex((e) => equal(e.workspaceId, workspace) && equal(e._id, id) && e.nextAttemptAt <= at
        && (e.status === "pending" || (e.status === "processing" && e.leaseUntil <= at)));
      if (index < 0) return null;
      state.events[index] = { ...state.events[index], status: "processing", leaseOwner: owner, leaseUntil: new Date(at.getTime() + 120000), attempts: state.events[index].attempts + 1 };
      return state.events[index];
    },
    finishEvent: async (event, patch) => {
      const index = state.events.findIndex((e) => equal(e._id, event._id) && equal(e.workspaceId, event.workspaceId) && e.status === "processing" && e.leaseOwner === event.leaseOwner);
      if (index < 0) return null;
      state.events[index] = { ...state.events[index], ...patch, leaseOwner: "", leaseUntil: null }; return state.events[index];
    },
    listEvents: async (workspace, { status, limit }) => state.events.filter((e) => equal(e.workspaceId, workspace) && e.status === status).slice(0, limit + 1),
    retryEvent: async (workspace, id, at) => {
      const index = state.events.findIndex((e) => equal(e.workspaceId, workspace) && equal(e._id, id) && e.status === "dead_letter");
      if (index < 0) return null;
      state.events[index] = { ...state.events[index], status: "pending", attempts: 0, nextAttemptAt: at }; return state.events[index];
    },
    createSession: async (fields) => { const record = { ...fields, usedAt: null }; state.sessions.push(record); return record; },
    findSession: async (tokenHash, at) => state.sessions.find((s) => s.tokenHash === tokenHash && !s.usedAt && s.expiresAt > at),
    consumeSession: async (record, at) => {
      const index = state.sessions.findIndex((s) => equal(s._id, record._id) && !s.usedAt && s.expiresAt > at);
      if (index < 0) return null;
      state.sessions[index] = { ...state.sessions[index], usedAt: at }; return state.sessions[index];
    },
  };
  const enabled = { value: true };
  const intake = createOrderIntake({ repo, enabled: () => enabled.value, ready: async () => {}, signingSecret: () => "example-signing-secret", now });
  const service = createOrdersService({ repo, now });
  const body = () => ({ object: "whatsapp_business_account", entry: [{ id: "123", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "456" }, contacts: [{ wa_id: "919999999999", profile: { name: "Test Customer" } }],
    messages: [{ id: "wamid.example", from: "919999999999", timestamp: String(Math.floor(now().getTime() / 1000)), type: "order",
      order: { catalog_id: "789", text: "Customer private note", product_items: [{ product_retailer_id: "tea", quantity: "2", item_price: "10.00", currency: "INR" }] } }],
  } }] }] });
  const signed = (payload = body()) => { const rawBody = Buffer.from(JSON.stringify(payload)); return { body: payload, rawBody,
    signature: `sha256=${crypto.createHmac("sha256", "example-signing-secret").update(rawBody).digest("hex")}` }; };
  const receive = () => intake.receiveOrders(signed());
  const create = async () => { await receive(); await intake.runOrderIntake(); return service.get(ws, state.orders[0]._id); };
  const editPickup = (order) => service.edit(ws, order.id, { revision: order.revision, fulfillmentMethod: "pickup", deliveryPrice: "0", deliveryTaxRateBps: null });
  const reviewInput = (order, quote) => ({ revision: order.revision, expectedTotalPaise: quote.totalPaise, productRevisions: quote.productRevisions, acknowledgeWarnings: true });
  return { state, repo, service, intake, enabled, body, signed, receive, create, editPickup, reviewInput, now,
    advance: (ms) => { time = new Date(time.getTime() + ms); } };
}
module.exports = { fixture, ws, otherWs, catalogId, productId, address };
