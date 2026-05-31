const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { decryptString } = require("@shared/utils/crypto");

function maskId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function activeConnectionFilter(workspaceId, { requireValid = true } = {}) {
  return {
    workspaceId,
    isActive: { $ne: false },
    ...(requireValid ? { isValid: true } : {}),
  };
}

async function findActiveConnectionDocument(workspaceId, select = "", options = {}) {
  return WhatsAppCredentials.findOne(activeConnectionFilter(workspaceId, options))
    .sort({ connectedAt: -1, updatedAt: -1 })
    .select(select);
}

async function resolveActiveConnection(workspaceId, options = {}) {
  const doc = await findActiveConnectionDocument(
    workspaceId,
    "+accessTokenEnc +phoneNumberIdEnc +businessAccountIdEnc phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain graphApiVersion displayPhoneNumber wabaName connectedAt",
    options
  );
  if (!doc) return null;

  const wabaId = String(doc.wabaId || doc.businessAccountIdPlain || decryptString(doc.businessAccountIdEnc) || "").trim();
  const phoneNumberId = String(doc.phoneNumberId || doc.phoneNumberIdPlain || decryptString(doc.phoneNumberIdEnc) || "").trim();
  const accessToken = decryptString(doc.accessTokenEnc);

  // eslint-disable-next-line no-console
  console.info("[whatsapp-metadata] active connection resolved", {
    workspaceId: String(workspaceId),
    maskedWabaId: maskId(wabaId),
    maskedPhoneNumberId: maskId(phoneNumberId),
  });
  // eslint-disable-next-line no-console
  console.info("[templates] active connection resolved", {
    workspaceId: String(workspaceId),
    maskedWabaId: maskId(wabaId),
    maskedPhoneNumberId: maskId(phoneNumberId),
  });

  return {
    doc,
    accessToken,
    wabaId,
    phoneNumberId,
    displayPhoneNumber: doc.displayPhoneNumber || null,
    wabaName: doc.wabaName || null,
    graphApiVersion: doc.graphApiVersion,
    connectedAt: doc.connectedAt || null,
  };
}

module.exports = {
  activeConnectionFilter,
  findActiveConnectionDocument,
  maskId,
  resolveActiveConnection,
};
