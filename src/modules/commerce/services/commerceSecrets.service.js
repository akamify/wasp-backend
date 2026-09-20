const { encryptString, decryptString } = require("@shared/utils/crypto");

function credentialContext({ workspaceId, recordId, field } = {}) {
  const workspace = String(workspaceId || "");
  const record = String(recordId || "");
  if (!/^[a-fA-F0-9]{24}$/.test(workspace) || !/^[a-fA-F0-9]{24}$/.test(record)
      || typeof field !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field)) {
    throw new TypeError("Invalid commerce encryption context");
  }
  return { workspaceId: workspace.toLowerCase(), recordId: record.toLowerCase(), field };
}

function encryptCommerceSecret(value, context) {
  const scope = credentialContext(context);
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new TypeError("Commerce secret must be a nonempty string of at most 1 MiB");
  }
  return encryptString(JSON.stringify({ version: 1, ...scope, value }));
}

function decryptCommerceSecret(ciphertext, context) {
  const scope = credentialContext(context);
  try {
    const envelope = JSON.parse(decryptString(ciphertext));
    if (envelope.version !== 1 || envelope.workspaceId !== scope.workspaceId
        || envelope.recordId !== scope.recordId || envelope.field !== scope.field
        || typeof envelope.value !== "string" || !envelope.value.length) {
      throw new Error("Invalid envelope");
    }
    return envelope.value;
  } catch {
    // Never include ciphertext, plaintext or crypto errors in an HTTP/log error.
    throw new Error("Commerce secret could not be decrypted for this record");
  }
}

module.exports = { encryptCommerceSecret, decryptCommerceSecret };

