const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { HttpError } = require("@shared/utils/httpError");
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

function isEmbeddedSignupConnection(doc) {
  const connectionMode = String(doc?.connectionMode || "").toLowerCase();
  const tokenType = String(doc?.tokenType || "").toLowerCase();
  const connectionMethod = String(doc?.connectionMethod || "").toLowerCase();
  return (
    connectionMode === "customer_embedded_signup" ||
    tokenType === "embedded_signup_customer_token" ||
    tokenType === "business_integration_token" ||
    connectionMethod === "embedded_signup"
  );
}

async function findActiveConnectionDocument(workspaceId, select = "", options = {}) {
  const docs = await WhatsAppCredentials.find(activeConnectionFilter(workspaceId, options))
    .sort({ connectedAt: -1, updatedAt: -1 })
    .select(select);
  if (!docs.length) return null;
  return docs.find(isEmbeddedSignupConnection) || docs[0] || null;
}

async function resolveActiveConnection(workspaceId, options = {}) {
  const doc = await findActiveConnectionDocument(
    workspaceId,
    "+accessTokenEnc +phoneNumberIdEnc +businessAccountIdEnc +tokenDebugSummary phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain graphApiVersion displayPhoneNumber wabaName connectedAt connectionMode tokenType",
    options
  );
  if (!doc) return null;

  const wabaId = String(doc.wabaId || doc.businessAccountIdPlain || decryptString(doc.businessAccountIdEnc) || "").trim();
  const phoneNumberId = String(doc.phoneNumberId || doc.phoneNumberIdPlain || decryptString(doc.phoneNumberIdEnc) || "").trim();
  const accessToken = decryptString(doc.accessTokenEnc);

  const embedded = isEmbeddedSignupConnection(doc);
  void embedded;

  return {
    doc,
    accessToken,
    wabaId,
    phoneNumberId,
    connectionMode: doc.connectionMode || null,
    tokenType: doc.tokenType || null,
    tokenDebug: doc.tokenDebugSummary || null,
    displayPhoneNumber: doc.displayPhoneNumber || null,
    wabaName: doc.wabaName || null,
    graphApiVersion: doc.graphApiVersion,
    connectedAt: doc.connectedAt || null,
  };
}

async function requireEmbeddedSignupConnection(workspaceId) {
  const connection = await resolveActiveConnection(workspaceId);
  if (!connection) throw new HttpError(400, "Active WhatsApp connection not configured");
  if (!isEmbeddedSignupConnection(connection.doc)) {
    throw new HttpError(409, "This workspace is using a manual/system-user token. Reconnect with Embedded Signup to use customer self-connect.");
  }
  return connection;
}

module.exports = {
  activeConnectionFilter,
  findActiveConnectionDocument,
  isEmbeddedSignupConnection,
  requireEmbeddedSignupConnection,
  resolveActiveConnection,
  maskId,
  getActiveWhatsAppConnection: resolveActiveConnection,
};
