require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict"), express = require("express"), { once } = require("node:events");
test("delivery action budgets isolate verified riders sharing the same restaurant IP", async (t) => {
  const { ecommerceDeliveryAction } = require("@core/middleware/rateLimiters");
  const app = express();
  // This harness supplies an authenticated principal; production routes run auth first.
  app.use((req, _res, next) => { req.user = { id: req.path === "/first" ? "rate-test-first" : "rate-test-second" }; next(); });
  app.use(ecommerceDeliveryAction); app.use((_req, res) => res.sendStatus(204));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 60; i++) assert.equal((await fetch(`${base}/first`)).status, 204);
  assert.equal((await fetch(`${base}/first`)).status, 429);
  assert.equal((await fetch(`${base}/second`)).status, 204);
});
