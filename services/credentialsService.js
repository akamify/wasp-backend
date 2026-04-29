const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { decryptString } = require("../utils/crypto");
const { hashForLookup } = require("../utils/hash");
const { HttpError } = require("../utils/httpError");

async function getCredentialsForUser(userId) {
  const doc = await WhatsAppCredentials.findOne({ workspaceId: userId }).select(
    "+accessTokenEnc +phoneNumberIdEnc +businessAccountIdEnc graphApiVersion isValid"
  );

  if (!doc) throw new HttpError(400, "WhatsApp credentials not configured");
  if (!doc.isValid) throw new HttpError(400, "WhatsApp credentials are not validated");

  const accessToken = decryptString(doc.accessTokenEnc);
  const phoneNumberId = decryptString(doc.phoneNumberIdEnc);
  const businessAccountId = decryptString(doc.businessAccountIdEnc);

  return {
    accessToken,
    phoneNumberId,
    businessAccountId,
    wabaId: businessAccountId,
    graphApiVersion: doc.graphApiVersion,
  };
}

async function findTenantByPhoneNumberId(phoneNumberId) {
  const phoneNumberIdHash = hashForLookup(phoneNumberId);
  const doc = await WhatsAppCredentials.findOne({ phoneNumberIdHash }).select(
    "workspaceId phoneNumberIdHash"
  );
  return doc || null;
}

module.exports = { getCredentialsForUser, findTenantByPhoneNumberId };
