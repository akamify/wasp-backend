const { encryptString } = require("@shared/utils/crypto");
const { HttpError } = require("@shared/utils/httpError");

function ensureNonBlankSecret(value) {
  if (String(value || "").trim() === "") {
    throw new HttpError(400, "Secret value cannot be blank");
  }
}

function maybeEncryptForStorage(def, parsedValue) {
  if (String(def?.valueType || "") !== "secret") return { storedValue: parsedValue, encrypted: false };
  ensureNonBlankSecret(parsedValue);
  return { storedValue: encryptString(String(parsedValue)), encrypted: true };
}

module.exports = { ensureNonBlankSecret, maybeEncryptForStorage };

