const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { decryptString } = require("@shared/utils/crypto");
const { hashForLookup } = require("@shared/utils/hash");
const { HttpError } = require("@shared/utils/httpError");

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
  const normalized = String(phoneNumberId || "").trim();
  if (!normalized) return null;

  // Stable fast path for multi-tenant routing.
  const byPlain = await WhatsAppCredentials.findOne({ phoneNumberIdPlain: normalized }).select(
    "workspaceId phoneNumberIdHash phoneNumberIdPlain"
  );
  if (byPlain) return byPlain;

  // Secondary path: deterministic hash lookup (if secret is configured and aligned).
  let byHash = null;
  try {
    const phoneNumberIdHash = hashForLookup(normalized);
    byHash = await WhatsAppCredentials.findOne({ phoneNumberIdHash }).select(
      "workspaceId phoneNumberIdHash phoneNumberIdPlain"
    );
  } catch {
    byHash = null;
  }
  if (byHash) return byHash;

  // Fallback path: if lookup secret changed across environments, compare decrypted values.
  // NOTE: We intentionally do NOT filter by isValid here.
  // Webhooks should still route to the right workspace even if the connection is mid-setup
  // or a validation flag drifted.
  const docs = await WhatsAppCredentials.find({}).select("workspaceId +phoneNumberIdEnc");
  for (const doc of docs) {
    try {
      const raw = decryptString(doc.phoneNumberIdEnc);
      if (String(raw).trim() === normalized) {
        // Self-heal stale routing fields after key/secret drift.
        const set = { phoneNumberIdPlain: normalized };
        try {
          set.phoneNumberIdHash = hashForLookup(normalized);
        } catch {}
        await WhatsAppCredentials.updateOne({ _id: doc._id }, { $set: set });
        return doc;
      }
    } catch {
      // Ignore corrupted rows and continue scanning.
    }
  }
  return null;
}

async function findTenantByWabaId(wabaId) {
  const normalized = String(wabaId || "").trim();
  if (!normalized) return null;

  const byPlain = await WhatsAppCredentials.findOne({ businessAccountIdPlain: normalized }).select(
    "workspaceId businessAccountIdHash businessAccountIdPlain"
  );
  if (byPlain) return byPlain;

  let byHash = null;
  try {
    const businessAccountIdHash = hashForLookup(normalized);
    byHash = await WhatsAppCredentials.findOne({ businessAccountIdHash }).select(
      "workspaceId businessAccountIdHash businessAccountIdPlain"
    );
  } catch {
    byHash = null;
  }
  if (byHash) return byHash;

  // NOTE: We intentionally do NOT filter by isValid here for webhook routing resiliency.
  const docs = await WhatsAppCredentials.find({}).select("workspaceId +businessAccountIdEnc");
  for (const doc of docs) {
    try {
      const raw = decryptString(doc.businessAccountIdEnc);
      if (String(raw).trim() === normalized) {
        const set = { businessAccountIdPlain: normalized };
        try {
          set.businessAccountIdHash = hashForLookup(normalized);
        } catch {}
        await WhatsAppCredentials.updateOne({ _id: doc._id }, { $set: set });
        return doc;
      }
    } catch {
      // Ignore corrupted rows and continue scanning.
    }
  }
  return null;
}

module.exports = { getCredentialsForUser, findTenantByPhoneNumberId, findTenantByWabaId };
