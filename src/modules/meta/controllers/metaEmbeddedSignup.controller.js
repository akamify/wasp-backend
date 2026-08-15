const { HttpError } = require("@shared/utils/httpError");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { decryptString } = require("@shared/utils/crypto");
const { Workspace } = require("@infra/database/Workspace");
const { stampUntaggedTemplatesForWaba, markTemplatesStaleForInactiveWabas } = require("@shared/services/templateOwnershipService");
const {
  refreshWhatsAppConnectionMetadata,
  serializeWhatsAppConnection,
} = require("@shared/services/whatsappConnectionMetadataService");
const { findLatestConnectionDocument, isEmbeddedSignupConnection } = require("@shared/services/whatsappConnectionService");
const templatesService = require("@modules/templates/services/templates.service");
const {
  changeEmbeddedSignupPin,
  executeEmbeddedSignupExchange,
  retryPhoneRegistration,
} = require("@modules/meta/services/embeddedSignup.service");
const { graphBaseUrl } = require("@modules/meta/services/metaGraph.service");

function mask(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

async function exchangeEmbeddedSignupCode(req, res) {
  const code = String(req.body?.code || "").trim();
  const wabaId = String(req.body?.waba_id || "").trim();
  const phoneNumberId = String(req.body?.phone_number_id || "").trim();
  const pin = String(req.body?.pin || "").trim();
  const flowId = String(req.body?.flow_id || "").trim() || null;
  const missing = {
    code: !code,
    waba_id: !wabaId,
  };

  if (missing.code || missing.waba_id) {
    return res.status(400).json({
      success: false,
      message: "Embedded signup details missing. Please complete signup popup flow.",
      missing,
    });
  }

  const result = await executeEmbeddedSignupExchange({
    workspace: req.workspace,
    user: req.user,
    code,
    wabaId,
    phoneNumberId,
    pin,
    flowId,
  });
  return res.json(result);
}

async function completePhoneRegistration(req, res) {
  const pin = String(req.body?.pin || "").trim();
  const connection = await retryPhoneRegistration({
    workspace: req.workspace,
    pin,
    actorUserId: req.user?.id || null,
  });
  const latest = await WhatsAppCredentials.findById(connection._id).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt lastMetaSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary onboardingStage registrationStatus registrationVersion phoneRegistrationState registrationLastAttemptAt registrationCompletedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired registrationRetryCount registrationLastError registrationLastErrorCode registrationRetryAllowed registrationRetryAfterAt registrationRecommendedAction businessManagerId templateSyncStatus templateSyncCompletedAt templateSyncLastError"
  );
  return res.json({
    success: true,
    connection: serializeWhatsAppConnection(latest),
  });
}

async function changePhonePin(req, res) {
  const pin = String(req.body?.pin || "").trim();
  const connection = await changeEmbeddedSignupPin({
    workspace: req.workspace,
    pin,
    actorUserId: req.user?.id || null,
  });
  const latest = await WhatsAppCredentials.findById(connection._id).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt lastMetaSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary onboardingStage registrationStatus registrationVersion phoneRegistrationState registrationLastAttemptAt registrationCompletedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired registrationRetryCount registrationLastError registrationLastErrorCode registrationRetryAllowed registrationRetryAfterAt registrationRecommendedAction businessManagerId templateSyncStatus templateSyncCompletedAt templateSyncLastError"
  );
  return res.json({
    success: true,
    connection: serializeWhatsAppConnection(latest),
  });
}

async function getWhatsAppConnection(req, res) {
  const row = await findLatestConnectionDocument(
    req.workspace.id,
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt lastMetaSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary onboardingStage registrationStatus registrationVersion phoneRegistrationState registrationLastAttemptAt registrationCompletedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired registrationRetryCount registrationLastError registrationLastErrorCode registrationRetryAllowed registrationRetryAfterAt registrationRecommendedAction businessManagerId templateSyncStatus templateSyncCompletedAt templateSyncLastError",
    { onlyEmbeddedSignup: false }
  );
  if (!row) return res.json(serializeWhatsAppConnection(null));
  return res.json(serializeWhatsAppConnection(row));
}

async function disconnectWhatsAppConnection(req, res) {
  const row = await findLatestConnectionDocument(req.workspace.id, "+accessTokenEnc +businessAccountIdEnc status", {
    onlyEmbeddedSignup: false,
  });
  if (!row) return res.json({ success: true, status: "disconnected" });
  const activeRow = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id, isActive: { $ne: false } }).select(
    "+accessTokenEnc +businessAccountIdEnc status"
  );

  try {
    const token = activeRow?.accessTokenEnc ? decryptString(activeRow.accessTokenEnc) : row.accessTokenEnc ? decryptString(row.accessTokenEnc) : "";
    const wabaId = activeRow?.businessAccountIdEnc ? decryptString(activeRow.businessAccountIdEnc) : row.businessAccountIdEnc ? decryptString(row.businessAccountIdEnc) : "";
    await stampUntaggedTemplatesForWaba({ workspaceId: req.workspace.id, wabaId });
    if (token && wabaId) {
      const axios = require("axios");
      await axios
        .delete(`${graphBaseUrl(row.graphApiVersion)}/${wabaId}/subscribed_apps`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 12000,
        })
        .catch(() => null);
    }
  } catch {}

  await WhatsAppCredentials.updateMany(
    { workspaceId: req.workspace.id, status: { $ne: "disconnected" } },
    { $set: { isActive: false, isValid: false, status: "disconnected", disconnectedAt: new Date() } }
  );
  await markTemplatesStaleForInactiveWabas({ workspaceId: req.workspace.id, activeWabaId: "" });
  return res.json({ success: true, status: "disconnected" });
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
  await WhatsAppCredentials.updateMany(
    { workspaceId: req.workspace.id, isActive: { $ne: false }, _id: { $ne: embedded._id } },
    { $set: { isActive: false, status: "disconnected", disconnectedAt: now } }
  );
  await WhatsAppCredentials.updateOne(
    { _id: embedded._id },
    {
      $set: {
        isActive: true,
        disconnectedAt: null,
      },
    }
  );

  await markTemplatesStaleForInactiveWabas({ workspaceId: req.workspace.id, activeWabaId: embedded.wabaId });
  await refreshWhatsAppConnectionMetadata(req.workspace.id).catch(() => null);
  await templatesService.syncMetaTemplates({ workspace: req.workspace, body: {} }).catch(() => null);

  const latest = await WhatsAppCredentials.findById(embedded._id).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt lastMetaSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary onboardingStage registrationStatus registrationVersion phoneRegistrationState registrationLastAttemptAt registrationCompletedAt registrationRetryCount registrationLastError businessManagerId templateSyncStatus templateSyncCompletedAt templateSyncLastError"
  );
  return res.json({
    success: true,
    connection: serializeWhatsAppConnection(latest),
  });
}

module.exports = {
  changePhonePin,
  completePhoneRegistration,
  disconnectWhatsAppConnection,
  exchangeEmbeddedSignupCode,
  forceEmbeddedActiveConnection,
  getWhatsAppConnection,
};
