require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { tokenFields, validSignature, gatewayDto } = require("../domain/gateway");
const v = require("../validators/gateway.validators");
const config = require("../services/gatewayConfig.service");
const { createRazorpayGateway } = require("../services/razorpayGateway.service");
const { isGatewayOAuthCallback, isGatewayOAuthWebhook } = require("../routes/gatewayHttp");
const time = new Date("2026-09-10T12:00:00Z");
const response = () => ({ token_type: "Bearer", expires_in: "3600", access_token: "test-access-token",
  refresh_token: "test-refresh-token", public_token: "rzp_test_oauth_example1234", razorpay_account_id: "acc_example123" });

test("manual validation separates environments, rejects OAuth public keys and disallows client authority fields", () => {
  const input = { environment: "test", keyId: "rzp_test_example1234", keySecret: "example-secret" };
  assert.deepEqual(v.parse(v.manual, input), input);
  for (const patch of [{ environment: "live" }, { keyId: "rzp_test_oauth_example1234" }, { merchantAccountId: "acc_untrusted" },
    { workspaceId: "100000000000000000000001" }, { identityVerified: true }, { keySecret: " secret " }]) {
    assert.throws(() => v.parse(v.manual, { ...input, ...patch }), { statusCode: 400 });
  }
});
test("token response checks actual environment, merchant identity and bounded expiry without inventing refresh account identity", () => {
  const data = response();
  const tokens = tokenFields(data, "test", time);
  assert.equal(tokens.tokenExpiresAt.toISOString(), "2026-09-10T13:00:00.000Z");
  assert.equal(tokens.refreshAfter.toISOString(), "2026-09-10T12:54:00.000Z");
  assert.throws(() => tokenFields(data, "live", time), { statusCode: 502 });
  assert.throws(() => tokenFields(data, "test", time, "acc_other"), { statusCode: 502 });
  delete data.razorpay_account_id;
  assert.throws(() => tokenFields(data, "test", time), { statusCode: 502 });
  assert.equal(tokenFields(data, "test", time, "acc_original").merchantAccountId, "acc_original");
  for (const ttl of [0, -1, 1.5, "garbage", Number.MAX_SAFE_INTEGER, null])
    assert.throws(() => tokenFields({ ...response(), expires_in: ttl }, "test", time), { statusCode: 502 });
});
test("gateway DTO never serializes selected secrets or future database fields", () => {
  const dto = gatewayDto({ _id: "gateway", keyIdEnc: "secret", keySecretEnc: "secret", accessTokenEnc: "secret",
    refreshTokenEnc: "secret", keyFingerprint: "secret", futureSecret: "secret", webhookSecretEnc: "secret", status: "connected" });
  assert.equal(JSON.stringify(dto).includes("secret"), false);
  assert.equal(dto.status, "connected");
});
test("webhook signatures cover exact raw bytes and support explicitly supplied old secrets", () => {
  const raw = Buffer.from('{ "event": "example" }');
  const signature = crypto.createHmac("sha256", "old-secret").update(raw).digest("hex");
  assert.equal(validSignature(raw, signature, ["current-secret", "old-secret"]), true);
  assert.equal(validSignature(Buffer.from(JSON.stringify(JSON.parse(raw))), signature, ["old-secret"]), false);
  for (const bad of ["", "a", "g".repeat(64), [signature], undefined]) assert.equal(validSignature(raw, bad, ["old-secret"]), false);
  assert.equal(validSignature(JSON.parse(raw), signature, ["old-secret"]), false);
});
test("OAuth settings require dedicated explicit flags, HTTPS callback and bounded old-secret lifetime", (t) => {
  const patch = { COMMERCE_GATEWAY_ENABLED: "true", COMMERCE_RAZORPAY_OAUTH_ENABLED: "true",
    COMMERCE_RAZORPAY_OAUTH_TEST_CLIENT_ID: "test-client", COMMERCE_RAZORPAY_OAUTH_TEST_CLIENT_SECRET: "test-client-secret",
    COMMERCE_RAZORPAY_OAUTH_TEST_REDIRECT_URI: "https://api.example.com/api/commerce/gateways/oauth/callback",
    COMMERCE_RAZORPAY_OAUTH_TEST_WEBHOOK_SECRET: "example-webhook-secret",
    COMMERCE_RAZORPAY_OAUTH_TEST_PREVIOUS_WEBHOOK_SECRET: "example-old-secret",
    COMMERCE_RAZORPAY_OAUTH_TEST_PREVIOUS_WEBHOOK_SECRET_EXPIRES_AT: "2026-09-10T12:01:00Z" };
  const original = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, patch);
  t.after(() => { for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  assert.equal(config.oauthConfig("test").clientId, "test-client");
  assert.equal(config.webhookConfig("test", time).secrets.length, 2);
  assert.equal(config.webhookConfig("test", new Date(time.getTime() + 60000)).secrets.length, 1);
  for (const url of ["http://api.example.com/api/commerce/gateways/oauth/callback", "https://api.example.com/other", `${patch.COMMERCE_RAZORPAY_OAUTH_TEST_REDIRECT_URI}?next=evil`]) {
    process.env.COMMERCE_RAZORPAY_OAUTH_TEST_REDIRECT_URI = url;
    assert.throws(() => config.oauthConfig("test"), { statusCode: 503 });
  }
  process.env.COMMERCE_RAZORPAY_OAUTH_TEST_REDIRECT_URI = patch.COMMERCE_RAZORPAY_OAUTH_TEST_REDIRECT_URI;
  process.env.COMMERCE_RAZORPAY_OAUTH_ENABLED = "false";
  assert.throws(() => config.oauthConfig("test"), { statusCode: 503 });
});
test("provider adapter probes read-only with merchant credentials, bounded requests and no response data leakage", async () => {
  const calls = [];
  const client = createRazorpayGateway({ request: async (request) => {
    calls.push(request); return { data: { entity: "collection", count: 1, items: [{ privateCustomerData: "private" }] } };
  } });
  assert.equal(await client.probe({ authType: "api_keys", keyId: "key", keySecret: "secret" }), undefined);
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/payments");
  assert.equal(calls[0].method, "GET"); assert.deepEqual(calls[0].params, { count: 1 });
  assert.deepEqual(calls[0].auth, { username: "key", password: "secret" });
  assert.equal(calls[0].maxRedirects, 0); assert.equal(calls[0].timeout, 15000);
  await client.probe({ authType: "oauth", accessToken: "merchant-token" });
  assert.deepEqual(calls[1].headers, { Authorization: "Bearer merchant-token" });
  assert.equal(calls[1].auth, undefined);
});
test("OAuth exchange sends explicit test mode and refresh uses a single request with the rotating token", async () => {
  const calls = [];
  const client = createRazorpayGateway({ request: async (request) => { calls.push(request); return { data: response() }; } });
  const cfg = { clientId: "partner-test", clientSecret: "partner-secret", redirectUri: "https://api.example.com/callback" };
  await client.exchange(cfg, "code", "test"); await client.refresh(cfg, "old-refresh");
  assert.equal(calls[0].url, "https://auth.razorpay.com/token");
  assert.equal(calls[0].data.mode, "test"); assert.equal(calls[0].data.redirect_uri, cfg.redirectUri);
  assert.equal(calls[1].data.grant_type, "refresh_token"); assert.equal(calls[1].data.refresh_token, "old-refresh");
  assert.equal(calls.length, 2);
});
test("provider transport and authentication errors never expose Axios credentials or provider payloads", async () => {
  for (const status of [401, 403, 429, 500, undefined]) {
    let calls = 0;
    const client = createRazorpayGateway({ request: async () => { calls++; throw { message: "sensitive", config: { password: "sensitive" }, response: { status, data: "sensitive" } }; } });
    await assert.rejects(client.refresh({}, "refresh-secret"), (error) => {
      assert.equal(JSON.stringify(error).includes("sensitive"), false);
      assert.equal(String(error).includes("sensitive"), false);
      assert.equal(error.authenticationRejected, status === 401 || status === 403); return true;
    });
    assert.equal(calls, 1);
  }
});
test("callback access-log exclusion and raw webhook routing cover root/API aliases and Express casing", () => {
  for (const path of ["/commerce/gateways/oauth/callback", "/api/commerce/gateways/oauth/callback/", "/API/COMMERCE/GATEWAYS/OAUTH/CALLBACK?code=secret"])
    assert.equal(isGatewayOAuthCallback(path), true);
  assert.equal(isGatewayOAuthCallback("/api/commerce/gateways/manual"), false);
  assert.equal(isGatewayOAuthWebhook("/API/commerce/gateways/oauth/webhooks/test/?a=b"), true);
  assert.equal(isGatewayOAuthWebhook("/api/wallet/webhook"), false);
});
test("documented Razorpay HTTP 400 authentication failure is classified without echoing provider descriptions", async () => {
  const client = createRazorpayGateway({ request: async () => { throw { response: { status: 400,
    data: { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed." } } } }; } });
  await assert.rejects(client.probe({ authType: "api_keys", keyId: "key", keySecret: "secret" }), (error) => {
    assert.equal(error.statusCode, 422); assert.equal(error.authenticationRejected, true);
    assert.equal(error.message, "Razorpay credentials were rejected."); return true;
  });
});
