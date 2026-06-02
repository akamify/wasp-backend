const { HttpError } = require("@shared/utils/httpError");
const { Workspace } = require("@infra/database/Workspace");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { maskId, isEmbeddedSignupConnection } = require("@shared/services/whatsappConnectionService");
const {
  refreshWhatsAppConnectionMetadata,
  serializeWhatsAppConnection,
} = require("@shared/services/whatsappConnectionMetadataService");
const { markTemplatesStaleForInactiveWabas } = require("@shared/services/templateOwnershipService");
const templatesService = require("@modules/templates/services/templates.service");

async function refreshConnectionMetadata(req, res) {
  const connection = await refreshWhatsAppConnectionMetadata(req.workspace.id);
  if (!connection) throw new HttpError(404, "Active WhatsApp connection not configured");
  return res.json({
    success: true,
    connection: serializeWhatsAppConnection(connection),
  });
}

async function forceEmbeddedActiveConnection(req, res) {
  const workspace = await Workspace.findById(req.workspace.id).select("ownerId ownerUserId");
  const isOwner = String(workspace?.ownerUserId || workspace?.ownerId || "") === String(req.user?.id || "");
  const isSuperAdmin = String(req.user?.role || "") === "super_admin";
  if (!workspace) throw new HttpError(404, "Workspace not found");
  if (!isOwner && !isSuperAdmin) throw new HttpError(403, "Owner or super admin access required");

  const rows = await WhatsAppCredentials.find({ workspaceId: req.workspace.id, isActive: { $ne: false } })
    .sort({ connectedAt: -1, updatedAt: -1 })
    .select(
      "_id wabaId phoneNumberId displayPhoneNumber wabaName connectionMode tokenType tokenDebugSummary connectedAt updatedAt status isActive"
    );
  const embedded = rows.find(isEmbeddedSignupConnection) || null;
  if (!embedded) throw new HttpError(404, "No Embedded Signup connection found for this workspace.");

  const now = new Date();
  const deactivated = await WhatsAppCredentials.updateMany(
    { workspaceId: req.workspace.id, isActive: { $ne: false }, _id: { $ne: embedded._id } },
    { $set: { isActive: false, status: "disconnected", disconnectedAt: now } }
  );
  await WhatsAppCredentials.updateOne(
    { _id: embedded._id },
    { $set: { isActive: true, status: "active", disconnectedAt: null, connectionMode: "customer_embedded_signup", tokenType: "embedded_signup_customer_token" } }
  );

  await markTemplatesStaleForInactiveWabas({ workspaceId: req.workspace.id, activeWabaId: embedded.wabaId });
  await refreshWhatsAppConnectionMetadata(req.workspace.id).catch(() => null);
  await templatesService.syncMetaTemplates({ workspace: req.workspace, body: {} }).catch(() => null);

  const latest = await WhatsAppCredentials.findById(embedded._id).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary"
  );
  return res.json({ success: true, connection: serializeWhatsAppConnection(latest) });
}

module.exports = { refreshConnectionMetadata, forceEmbeddedActiveConnection };
