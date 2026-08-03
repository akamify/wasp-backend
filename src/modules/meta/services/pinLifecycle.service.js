const { encryptString, decryptString } = require("@shared/utils/crypto");
const { HttpError } = require("@shared/utils/httpError");

function normalizePin(pin) {
  return String(pin || "").replace(/\D/g, "").slice(0, 6);
}

function assertValidPin(pin) {
  const normalized = normalizePin(pin);
  if (!/^\d{6}$/.test(normalized)) {
    throw new HttpError(400, "A 6-digit WhatsApp registration PIN is required.");
  }
  return normalized;
}

function encryptPin(pin) {
  return encryptString(assertValidPin(pin));
}

function decryptPin(pinEnc) {
  if (!pinEnc) return "";
  return normalizePin(decryptString(pinEnc));
}

module.exports = {
  assertValidPin,
  decryptPin,
  encryptPin,
  normalizePin,
};
