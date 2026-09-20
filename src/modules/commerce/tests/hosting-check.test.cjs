const { test } = require("node:test"), assert = require("node:assert/strict");
const { inspect, main } = require("../../../../scripts/commerce-hosting-check.cjs");
function environment() { return { NODE_ENV: "production", MONGODB_URI: "mongodb://test:private-mongo@localhost:27017/commerce", REDIS_URL: "redis://:private-redis@localhost:6379",
  JWT_SECRET: "test-signing-secret-".repeat(3), CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), LOOKUP_SECRET: "test-lookup",
  META_APP_ID: "123", META_APP_SECRET: "private-meta", META_WEBHOOK_VERIFY_TOKEN: "private-verify", FRONTEND_BASE_URL: "https://app.example.com",
  META_GRAPH_VERSION: "v25.0", COMMERCE_CATALOG_ENABLED: "true", COMMERCE_ORDERS_ENABLED: "true", COMMERCE_GATEWAY_ENABLED: "true", COMMERCE_PAYMENTS_ENABLED: "true" }; }
test("hosting plan has no connections and configuration report discloses no secrets", () => {
  const env = environment(), plan = main([], env), result = inspect(env);
  assert.equal(plan.mode, "plan"); assert.equal(result.result, "PASS"); assert.equal(result.scope, "configuration-only");
  assert.equal(result.checkoutEnabled, false);
  for (const value of [env.MONGODB_URI, env.REDIS_URL, env.JWT_SECRET, env.CREDENTIALS_ENCRYPTION_KEY, env.META_APP_SECRET])
    assert.equal(JSON.stringify(result).includes(value), false);
  assert.throws(() => main(["--apply"], env));
  assert.equal(inspect({ ...env, MONGODB_URI: "mongodb://db1:27017,db2:27017/commerce?replicaSet=rs0" }).result, "PASS");
  assert.equal(inspect({ ...env, MONGODB_URI: "mongodb+srv://user:password@cluster.example.com/commerce" }).result, "PASS");
});
test("hosting checks reject missing secrets, disabled Redis, invalid switches and unsafe public origins", () => {
  for (const patch of [{ JWT_SECRET: "dev_jwt_secret_change_me" }, { CREDENTIALS_ENCRYPTION_KEY: "broken" }, { DISABLE_REDIS: "true" },
    { REDIS_URL: "https://example.com" }, { MONGODB_URI: "bad" }, { FRONTEND_BASE_URL: "http://app.example.com" },
    { FRONTEND_BASE_URL: "https://user:secret@app.example.com" }, { COMMERCE_PAYMENTS_ENABLED: "false" }, { COMMERCE_CHECKOUT_ENABLED: "yes" },
    { META_GRAPH_VERSION: "" }, { LOOKUP_SECRET: "" }, { COMMERCE_LIVE_CHECKOUT_ENABLED: "true" }]) assert.equal(inspect({ ...environment(), ...patch }).result, "FAIL");
});
test("hosting native and OAuth flags require exact prerequisites without assuming merchant eligibility", () => {
  const env = { ...environment(), COMMERCE_NATIVE_PAYMENTS_ENABLED: "true" };
  assert.equal(inspect(env).result, "FAIL");
  Object.assign(env, { COMMERCE_CHECKOUT_ENABLED: "true", COMMERCE_LIVE_CHECKOUT_ENABLED: "true", COMMERCE_NATIVE_ACCEPTED_BINDINGS: `${"a".repeat(24)}:123:456:${"b".repeat(24)}` });
  assert.equal(inspect(env).result, "PASS"); env.COMMERCE_RAZORPAY_OAUTH_ENABLED = "true"; assert.equal(inspect(env).result, "FAIL");
  Object.assign(env, { COMMERCE_RAZORPAY_OAUTH_LIVE_CLIENT_ID: "test-client", COMMERCE_RAZORPAY_OAUTH_LIVE_CLIENT_SECRET: "private-client-secret",
    COMMERCE_RAZORPAY_OAUTH_LIVE_REDIRECT_URI: "https://api.example.com/api/commerce/gateways/oauth/callback", COMMERCE_RAZORPAY_OAUTH_LIVE_WEBHOOK_SECRET: "private-webhook-secret" });
  assert.equal(inspect(env).result, "PASS"); env.COMMERCE_RAZORPAY_OAUTH_LIVE_REDIRECT_URI = "malformed";
  assert.equal(inspect(env).result, "FAIL");
});
