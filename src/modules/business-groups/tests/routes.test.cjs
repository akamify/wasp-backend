require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const service = require("../service");

test("HTTP group routes require merchant authentication, reject mass assignment, ignore workspace headers and expose no commerce writes", async (t) => {
  const authModule = require("@core/middleware/auth");
  t.mock.method(authModule, "auth", (req, res, next) => {
    if (!req.headers["x-test-user"]) return res.status(401).json({ message: "Sign in" });
    req.user = { id: "100000000000000000000001", accountType: req.headers["x-test-user"] }; next();
  });
  t.mock.method(service, "overview", async (id) => { assert.equal(id, "100000000000000000000001"); return { group: null }; });
  let writes = 0;
  t.mock.method(service, "requestLink", async () => { writes++; return { status: "pending" }; });
  const app = express(); app.use(express.json()); app.use("/business-groups", require("../routes"));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/business-groups`;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers: { "x-test-user": "admin_account" } })).status, 403);
  const headers = { "x-test-user": "user", "content-type": "application/json", "x-workspace-id": "another-tenant" };
  const read = await fetch(base, { headers }); assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/links`, { method: "POST", headers, body: JSON.stringify({ workspaceId: "100000000000000000000001", status: "active" }) })).status, 400);
  assert.equal(writes, 0);
  assert.equal((await fetch(`${base}/links`, { method: "POST", headers, body: JSON.stringify({ workspaceId: "100000000000000000000001" }) })).status, 200);
  assert.equal(writes, 1);
  assert.equal((await fetch(`${base}/report?workspaceIds=another-tenant`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/orders/123`, { method: "PATCH", headers, body: "{}" })).status, 404);
});
