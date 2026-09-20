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
const { errorHandler } = require("@core/middleware/errorHandler");
const readiness = require("../services/catalogReadiness.service");
const service = require("../services/catalog.service");
const audit = require("@shared/services/auditLog.service");

test("Commerce HTTP routes enforce real authentication, membership, permissions and Express 5 query validation", async (t) => {
  const workspaceId = "100000000000000000000001";
  const userId = "200000000000000000000001";
  let role = "viewer", member = true, serviceCalls = 0;
  t.mock.method(User, "findById", () => ({ select: async () => ({ _id: userId, role: "user", status: "active", tokenVersion: 0 }) }));
  t.mock.method(Workspace, "findOne", async (query) => query._id === workspaceId
    ? { _id: workspaceId, ownerId: "someone-else", isActive: true, status: "active" } : null);
  t.mock.method(WorkspaceMember, "findOne", async () => member ? { role, permissionsOverride: {} } : null);
  t.mock.method(readiness, "assertCatalogReady", async () => {});
  t.mock.method(audit, "writeAuditLog", async () => {});
  t.mock.method(service, "listProducts", async (ws, query) => {
    serviceCalls++; assert.equal(ws, workspaceId); assert.equal(query.limit, 2); assert.equal(query.archived, false);
    return { products: [], nextCursor: null };
  });
  t.mock.method(service, "createProduct", async (ws, data) => {
    serviceCalls++; assert.equal(ws, workspaceId); assert.equal(data.price, "10.00");
    return { id: "product-test", revision: 1 };
  });
  const setup = require("../services/catalogSetup.service");
  t.mock.method(setup, "create", async (ws, data) => {
    assert.equal(ws, workspaceId); assert.equal(data.name, "Menu");
    return { id: "catalog-test", revision: 1 };
  });
  const router = require("../routes/catalog.routes");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/commerce", router); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/commerce`;
  const token = jwt.sign({ sub: userId, tokenVersion: 0 }, jwtSecret, { expiresIn: "1m" });
  const headers = { Authorization: `Bearer ${token}`, "x-workspace-id": workspaceId, "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/products`)).status, 401);
  assert.equal((await fetch(`${base}/products?limit=2`, { headers })).status, 200);
  assert.equal(serviceCalls, 1);
  assert.equal((await fetch(`${base}/products?limit=10000`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/products`, { method: "POST", headers, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/catalog/create`, { method: "POST", headers, body: "{}" })).status, 403);
  member = false;
  assert.equal((await fetch(`${base}/products?limit=2`, { headers })).status, 404);
  member = true; role = "manager";
  assert.equal((await fetch(`${base}/catalog/create`, { method: "POST", headers, body: JSON.stringify({ name: "Menu", confirmOwnership: true, workspaceId: "other" }) })).status, 400);
  assert.equal((await fetch(`${base}/catalog/create`, { method: "POST", headers, body: JSON.stringify({ name: "Menu", confirmOwnership: true }) })).status, 201);
  const body = { sku: "tea", name: "Tea", description: "Tea", imageUrl: "https://example.com/a.jpg",
    productUrl: "https://example.com/a", price: "10.00", condition: "new", taxRateBps: null, taxConfirmed: true };
  assert.equal((await fetch(`${base}/products`, { method: "POST", headers, body: JSON.stringify({ ...body, workspaceId: "other" }) })).status, 400);
  assert.equal((await fetch(`${base}/products`, { method: "POST", headers, body: JSON.stringify(body) })).status, 201);
  assert.equal(serviceCalls, 2);
  assert.equal((await fetch(`${base}/products?limit=2`, { headers: { ...headers, "x-workspace-id": "100000000000000000000002" } })).status, 404);
});
