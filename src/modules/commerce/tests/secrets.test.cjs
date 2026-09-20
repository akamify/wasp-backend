require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { encryptCommerceSecret, decryptCommerceSecret } = require("../services/commerceSecrets.service");

test("credential encryption is randomized, authenticated and bound to the workspace, record and field", (t) => {
  const previous = process.env.CREDENTIALS_ENCRYPTION_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = previous;
  });
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  const context = { workspaceId: "100000000000000000000001", recordId: "200000000000000000000001", field: "keySecretEnc" };
  const plaintext = "test-only-secret";
  const first = encryptCommerceSecret(plaintext, context);
  const second = encryptCommerceSecret(plaintext, context);
  assert.notEqual(first, second);
  assert.equal(first.includes(plaintext), false);
  assert.equal(decryptCommerceSecret(first, context), plaintext);
  for (const change of [{ workspaceId: "100000000000000000000002" }, { recordId: "200000000000000000000002" }, { field: "accessTokenEnc" }]) {
    assert.throws(() => decryptCommerceSecret(first, { ...context, ...change }), /could not be decrypted/);
  }
  const parts = first.split(".");
  const bytes = Buffer.from(parts[2], "base64");
  bytes[0] ^= 1;
  parts[2] = bytes.toString("base64");
  assert.throws(() => decryptCommerceSecret(parts.join("."), context), /could not be decrypted/);
  for (const input of ["", "bad", null]) assert.throws(() => decryptCommerceSecret(input, context), /could not be decrypted/);
  for (const input of ["", null, {}, "x".repeat(1024 * 1024 + 1)]) assert.throws(() => encryptCommerceSecret(input, context), TypeError);
  assert.throws(() => encryptCommerceSecret(plaintext, { ...context, workspaceId: "" }), TypeError);
  delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  assert.throws(() => encryptCommerceSecret(plaintext, context), /Missing CREDENTIALS_ENCRYPTION_KEY/);
});

