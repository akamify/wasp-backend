const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getSecretKey() {
  const raw = String(process.env.TOKEN_ENCRYPTION_SECRET || "").trim();
  if (!raw || raw.length < 32) {
    throw new Error("Missing TOKEN_ENCRYPTION_SECRET (minimum 32 characters)");
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encryptSecret(value) {
  if (value == null) return "";
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

function decryptSecret(value) {
  if (!value) return "";
  const [ivB64, tagB64, dataB64] = String(value).split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted secret payload");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid secret IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid secret auth tag length");
  const decipher = crypto.createDecipheriv(ALGO, getSecretKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };

