const { HttpError } = require("@shared/utils/httpError");
const { resolveActiveConnection } = require("@shared/services/whatsappConnectionService");

async function requireActiveWabaScope(workspaceId) {
  const connection = await resolveActiveConnection(workspaceId);
  if (!connection?.wabaId) {
    throw new HttpError(409, "Connect WhatsApp for this workspace first.");
  }
  return {
    workspaceId: String(workspaceId),
    wabaId: String(connection.wabaId),
    phoneNumberId: String(connection.phoneNumberId || ""),
  };
}

async function activeWabaFilter(workspaceId) {
  const scope = await requireActiveWabaScope(workspaceId);
  return { workspaceId: scope.workspaceId, wabaId: scope.wabaId };
}

module.exports = { activeWabaFilter, requireActiveWabaScope };
