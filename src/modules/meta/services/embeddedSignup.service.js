const crypto = require("crypto");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { hashForLookup } = require("@shared/utils/hash");
const { decryptString, encryptString } = require("@shared/utils/crypto");
const { encryptSecret } = require("@shared/utils/secretCrypto");
const { HttpError } = require("@shared/utils/httpError");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const { markTemplatesStaleForInactiveWabas, stampUntaggedTemplatesForWaba } = require("@shared/services/templateOwnershipService");
const { logWorkspaceActivity } = require("@modules/workspaces/services/workspaceActivity.service");
const {
  ONBOARDING_STAGES,
  REGISTRATION_STATUSES,
  REGISTRATION_VERSION,
  REQUIRED_EMBEDDED_SIGNUP_SCOPES,
  TEMPLATE_SYNC_STATUSES,
} = require("@modules/meta/constants/embeddedSignup.constants");
const { createMetaClient, getMetaGraphVersion } = require("@modules/meta/services/metaGraph.service");
const { normalizeMetaError, sanitizeMetaError } = require("@modules/meta/services/metaError.service");
const { ensureWebhookSubscription } = require("@modules/meta/services/webhookSubscription.service");
const {
  changeTwoStepVerificationPin,
  classifyRegistrationError,
  registerPhoneNumber,
} = require("@modules/meta/services/phoneRegistration.service");
const { syncConnectionMetadata } = require("@modules/meta/services/metadataSync.service");
const { syncTemplatesForWorkspace } = require("@modules/meta/services/templateSync.service");
const { decryptPin, encryptPin } = require("@modules/meta/services/pinLifecycle.service");
const { getToken, META_TOKEN_TYPES } = require("@modules/meta/services/tokenProvider.service");
const { ensureSystemUserProvisionedOnWaba } = require("@modules/meta/services/wabaProvisioning.service");
const { findLatestConnectionDocument } = require("@shared/services/whatsappConnectionService");
const { serializeWhatsAppConnection } = require("@shared/services/whatsappConnectionMetadataService");

const REGISTRATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const EXCHANGE_RESULT_TTL_MS = 10 * 60 * 1000;
const embeddedSignupExchangeCache = new Map();

function maskId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function fingerprint(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function buildExchangeCacheKey({ workspaceId, code }) {
  return [
    String(workspaceId || "").trim(),
    fingerprint(code),
  ].join(":");
}

function pruneExpiredExchangeCache(now = Date.now()) {
  for (const [key, entry] of embeddedSignupExchangeCache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      embeddedSignupExchangeCache.delete(key);
    }
  }
}

async function runDedupedExchange({ cacheKey, logContext }, executor) {
  const now = Date.now();
  pruneExpiredExchangeCache(now);
  const existing = embeddedSignupExchangeCache.get(cacheKey);

  if (existing?.status === "pending" && existing.promise) {
    console.info("[meta-embedded-signup] duplicate exchange request joined in-flight attempt", logContext);
    return existing.promise;
  }

  if (existing?.status === "resolved" && existing.result) {
    console.info("[meta-embedded-signup] duplicate exchange request served from recent result cache", logContext);
    return existing.result;
  }

  const promise = (async () => {
    try {
      const result = await executor();
      embeddedSignupExchangeCache.set(cacheKey, {
        status: "resolved",
        result,
        expiresAt: Date.now() + EXCHANGE_RESULT_TTL_MS,
      });
      return result;
    } catch (error) {
      embeddedSignupExchangeCache.delete(cacheKey);
      throw error;
    }
  })();

  embeddedSignupExchangeCache.set(cacheKey, {
    status: "pending",
    promise,
    expiresAt: now + EXCHANGE_RESULT_TTL_MS,
  });
  return promise;
}

function buildTokenDebugSummary(tokenDebugData) {
  if (!tokenDebugData) return null;
  return {
    appId: tokenDebugData.app_id ? maskId(tokenDebugData.app_id) : null,
    type: tokenDebugData.type || null,
    application: tokenDebugData.application || null,
    userId: tokenDebugData.user_id || null,
    isValid: Boolean(tokenDebugData.is_valid),
    expiresAt: tokenDebugData.expires_at ? new Date(Number(tokenDebugData.expires_at) * 1000).toISOString() : null,
    issuedAt: tokenDebugData.issued_at ? new Date(Number(tokenDebugData.issued_at) * 1000).toISOString() : null,
    scopes: Array.isArray(tokenDebugData.scopes) ? tokenDebugData.scopes : [],
    granularScopes: Array.isArray(tokenDebugData.granular_scopes) ? tokenDebugData.granular_scopes : [],
  };
}

function buildRegistrationWindow(baseDate = new Date()) {
  const embeddedSignupCompletedAt = new Date(baseDate);
  const registrationDeadlineAt = new Date(embeddedSignupCompletedAt.getTime() + REGISTRATION_WINDOW_MS);
  return { embeddedSignupCompletedAt, registrationDeadlineAt };
}

function buildMetaStepError(err, {
  step,
  endpoint,
  tokenType,
  message,
  workspaceId,
  extraDetails = {},
}) {
  const normalized = normalizeMetaError(err, message);
  const statusCode = Number(normalized.status || err?.statusCode || 0) || 500;
  const details = {
    step,
    endpoint,
    tokenType,
    workspaceId: workspaceId ? String(workspaceId) : null,
    meta: normalized,
    providerError: normalized.message,
    ...extraDetails,
  };

  console.error("[meta-embedded-signup] step failed", {
    step,
    endpoint,
    tokenType,
    workspaceId: workspaceId ? String(workspaceId) : null,
    status: normalized.status,
    code: normalized.code,
    subcode: normalized.subcode,
    fbtraceId: normalized.fbtraceId,
    message: normalized.message,
  });

  return new HttpError(statusCode >= 400 && statusCode < 600 ? statusCode : 500, message, details);
}

function isUsedAuthorizationCodeError(err) {
  const meta = err?.response?.data?.error || err?.details?.meta || null;
  const code = Number(meta?.code || err?.code || 0);
  const subcode = Number(meta?.error_subcode || meta?.subcode || err?.subcode || 0);
  const message = String(meta?.message || err?.message || "").toLowerCase();
  return (
    (code === 100 && subcode === 36009) ||
    message.includes("authorization code has been used") ||
    message.includes("this authorization code has been used")
  );
}

async function recoverExistingEmbeddedSignupSession({ workspaceId, wabaId, phoneNumberId }) {
  const doc = await findLatestConnectionDocument(
    workspaceId,
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt lastMetaSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary onboardingStage registrationStatus registrationVersion phoneRegistrationState registrationLastAttemptAt registrationCompletedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired registrationRetryCount registrationLastError registrationLastErrorCode registrationRetryAllowed registrationRetryAfterAt registrationRecommendedAction businessManagerId templateSyncStatus templateSyncCompletedAt templateSyncLastError",
    { onlyEmbeddedSignup: true }
  );
  if (!doc) return null;

  const docWabaId = String(doc.wabaId || doc.businessAccountIdPlain || "").trim();
  const docPhoneNumberId = String(doc.phoneNumberId || doc.phoneNumberIdPlain || "").trim();
  if (wabaId && docWabaId && String(wabaId).trim() !== docWabaId) return null;
  if (phoneNumberId && docPhoneNumberId && String(phoneNumberId).trim() !== docPhoneNumberId) return null;

  const connection = serializeWhatsAppConnection(doc);
  const lifecycleState = String(connection?.lifecycleState || connection?.onboardingStage || "").trim();
  const registrationStatus = String(connection?.registrationStatus || "").trim();
  const resumableStates = [
    ONBOARDING_STAGES.PIN_REQUIRED,
    ONBOARDING_STAGES.REGISTERING,
    ONBOARDING_STAGES.PHONE_REGISTERED,
    ONBOARDING_STAGES.METADATA_SYNCING,
    ONBOARDING_STAGES.TEMPLATE_SYNCING,
    ONBOARDING_STAGES.SYNC_WARNING,
    ONBOARDING_STAGES.FAILED,
    ONBOARDING_STAGES.READY,
    ONBOARDING_STAGES.READY_WITH_WARNINGS,
  ];
  if (!resumableStates.includes(lifecycleState)) return null;

  return {
    success: true,
    connected: Boolean(connection?.connected),
    status: connection?.connected ? "active" : "pending",
    recoveredFromUsedCode: true,
    requiresPinSetup: [
      REGISTRATION_STATUSES.PIN_REQUIRED,
      REGISTRATION_STATUSES.PENDING,
      REGISTRATION_STATUSES.FAILED,
      REGISTRATION_STATUSES.RETRYING,
    ].includes(registrationStatus),
    connectionId: String(doc._id),
    lifecycleState,
    onboardingStage: lifecycleState,
    registrationStatus,
    embeddedSignupCompletedAt: connection?.embeddedSignupCompletedAt || null,
    registrationDeadlineAt: connection?.registrationDeadlineAt || null,
    message: "Previous Meta signup session already started. Resuming existing onboarding state.",
    connection,
  };
}

async function inspectExistingEmbeddedSignupState({ workspaceId }) {
  const doc = await findLatestConnectionDocument(
    workspaceId,
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt lastMetaSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary onboardingStage registrationStatus registrationVersion phoneRegistrationState registrationLastAttemptAt registrationCompletedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired registrationRetryCount registrationLastError registrationLastErrorCode registrationRetryAllowed registrationRetryAfterAt registrationRecommendedAction businessManagerId templateSyncStatus templateSyncCompletedAt templateSyncLastError",
    { onlyEmbeddedSignup: true }
  );
  if (!doc) return null;

  const connection = serializeWhatsAppConnection(doc);
  return {
    connectionId: String(doc._id),
    status: connection?.status || null,
    connected: Boolean(connection?.connected),
    lifecycleState: connection?.lifecycleState || connection?.onboardingStage || null,
    registrationStatus: connection?.registrationStatus || null,
    wabaId: String(connection?.wabaId || "").trim() || null,
    phoneNumberId: String(connection?.phoneNumberId || "").trim() || null,
  };
}

async function exchangeCodeForToken(code) {
  const { metaAppId, metaAppSecret } = getMetaAppConfig();
  const client = createMetaClient({ graphApiVersion: getMetaGraphVersion(), timeout: 20000 });
  const response = await client.get("/oauth/access_token", {
    params: { client_id: metaAppId, client_secret: metaAppSecret, code },
  });
  const token = String(response?.data?.access_token || "").trim();
  if (!token) throw new HttpError(400, "Could not exchange Meta code.");
  return { token, appId: metaAppId };
}

async function debugBusinessToken({ token, graphApiVersion }) {
  const client = createMetaClient({ graphApiVersion, timeout: 20000 });
  const systemUserToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });
  const response = await client.get("/debug_token", {
    headers: { Authorization: `Bearer ${systemUserToken}` },
    params: {
      input_token: token,
    },
  });
  return response?.data?.data || null;
}

function validateTokenScopes(debugTokenData, wabaId, appId) {
  if (debugTokenData?.is_valid !== true) {
    throw new HttpError(400, "Meta returned an invalid business token. Please reconnect WhatsApp.");
  }
  if (String(debugTokenData?.app_id || "").trim() !== String(appId || "").trim()) {
    throw new HttpError(400, "Meta returned a token for a different app. Verify the Embedded Signup configuration and reconnect WhatsApp.");
  }
  const scopes = Array.isArray(debugTokenData?.scopes) ? debugTokenData.scopes : [];
  const granularScopes = Array.isArray(debugTokenData?.granular_scopes) ? debugTokenData.granular_scopes : [];
  const granularScopeNames = granularScopes.map((scope) => String(scope?.scope || "").trim()).filter(Boolean);
  const grantedScopes = [...new Set([...scopes, ...granularScopeNames])];
  const missingScopes = REQUIRED_EMBEDDED_SIGNUP_SCOPES.filter((scope) => !grantedScopes.includes(scope));
  if (missingScopes.length) {
    throw new HttpError(400, "Meta token is missing required WhatsApp permissions.", {
      missingScopes,
      grantedScopes,
    });
  }
  const targetIds = granularScopes.flatMap((scope) =>
    Array.isArray(scope?.target_ids) ? scope.target_ids.map((targetId) => String(targetId).trim()).filter(Boolean) : []
  );
  if (targetIds.length && !targetIds.includes(String(wabaId))) {
    throw new HttpError(400, "Meta token is not scoped to the selected WhatsApp Business Account.");
  }
  return grantedScopes;
}

async function discoverPhoneNumber({ wabaId, phoneNumberId, graphApiVersion, accessToken }) {
  const client = createMetaClient({ graphApiVersion, timeout: 20000 });
  const response = await client.get(`/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { fields: "id,display_phone_number" },
  });
  const phones = Array.isArray(response?.data?.data) ? response.data.data : [];
  if (!phoneNumberId) {
    return { matchedPhone: null, phones };
  }
  const matchedPhone = phones.find((row) => String(row?.id || "").trim() === String(phoneNumberId).trim()) || null;
  if (!matchedPhone) {
    throw new HttpError(400, "Selected phone number could not be matched to the selected WABA. Please reconnect WhatsApp and select the correct phone number.");
  }
  return { matchedPhone, phones };
}

async function persistOnboardingConnection({
  workspaceId,
  userId,
  accessToken,
  wabaId,
  phoneNumber,
  debugTokenData,
  subscribed,
  onboardingStage,
  registrationStatus,
  pin,
  businessManagerId,
  wabaName,
}) {
  const now = new Date();
  const { embeddedSignupCompletedAt, registrationDeadlineAt } = buildRegistrationWindow(now);
  return WhatsAppCredentials.create({
    workspaceId,
    accessTokenEnc: encryptString(accessToken),
    businessTokenEnc: encryptSecret(accessToken),
    phoneNumberIdEnc: encryptString(String(phoneNumber.id)),
    businessAccountIdEnc: encryptString(wabaId),
    phoneNumberIdHash: hashForLookup(String(phoneNumber.id)),
    businessAccountIdHash: hashForLookup(wabaId),
    phoneNumberIdPlain: String(phoneNumber.id),
    businessAccountIdPlain: wabaId,
    phoneNumberId: String(phoneNumber.id),
    wabaId,
    graphApiVersion: getMetaGraphVersion(),
    connectionMode: "customer_embedded_signup",
    tokenType: "embedded_signup_customer_token",
    tokenDebugSummary: buildTokenDebugSummary(debugTokenData),
    displayPhoneNumber: String(phoneNumber?.display_phone_number || "").trim() || null,
    wabaName: wabaName || null,
    businessManagerId: businessManagerId || null,
    isValid: false,
    isActive: false,
    status: "pending",
    webhookSubscribed: subscribed,
    connectionMethod: "embedded_signup",
    onboardingStage,
    registrationStatus,
    registrationVersion: REGISTRATION_VERSION,
    phoneRegistrationState: registrationStatus,
    registrationRetryCount: 0,
    registrationLastError: null,
    registrationLastErrorCode: null,
    registrationRetryAllowed: null,
    registrationRetryAfterAt: null,
    registrationRecommendedAction: null,
    lastError: null,
    lastValidatedAt: now,
    connectedAt: null,
    disconnectedAt: null,
    lastEditedAt: now,
    lastEditedBy: userId || null,
    phoneRegistrationPinEnc: pin ? encryptPin(pin) : null,
    phoneRegistrationPinUpdatedAt: pin ? now : null,
    embeddedSignupCompletedAt,
    registrationDeadlineAt,
    registrationExpired: false,
    templateSyncStatus: TEMPLATE_SYNC_STATUSES.NOT_STARTED,
    templateSyncLastError: null,
    lastMetaSyncAt: null,
  });
}

function buildConnectionContext(doc) {
  const wabaId = String(doc.wabaId || doc.businessAccountIdPlain || (doc.businessAccountIdEnc ? decryptString(doc.businessAccountIdEnc) : "")).trim();
  const phoneNumberId = String(doc.phoneNumberId || doc.phoneNumberIdPlain || (doc.phoneNumberIdEnc ? decryptString(doc.phoneNumberIdEnc) : "")).trim();
  const accessToken = doc.accessTokenEnc ? decryptString(doc.accessTokenEnc) : "";
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

async function ensureRegistrationWindowOpen(doc) {
  const now = new Date();
  const deadline = doc.registrationDeadlineAt ? new Date(doc.registrationDeadlineAt) : null;
  const expired = Boolean(doc.registrationExpired) || (deadline && deadline.getTime() < now.getTime());
  if (!expired) return;
  await doc.updateOne({
    $set: {
      registrationExpired: true,
      registrationStatus: REGISTRATION_STATUSES.EXPIRED,
      onboardingStage: ONBOARDING_STAGES.FAILED,
      registrationRetryAllowed: false,
      registrationRecommendedAction: "Embedded Signup expired. Restart Embedded Signup before attempting registration again.",
    },
  });
  throw new HttpError(409, "The Meta registration window expired. Restart Embedded Signup before registering this phone number.");
}

async function activateReadyConnection({ doc, workspaceId }) {
  const now = new Date();
  const previousActive = await WhatsAppCredentials.findOne({
    workspaceId,
    isActive: true,
    _id: { $ne: doc._id },
  }).select("+businessAccountIdEnc businessAccountIdPlain");
  const previousWabaId = String(
    previousActive?.businessAccountIdPlain ||
      (previousActive?.businessAccountIdEnc ? decryptString(previousActive.businessAccountIdEnc) : "")
  ).trim();
  if (previousWabaId) {
    await stampUntaggedTemplatesForWaba({ workspaceId, wabaId: previousWabaId });
  }
  await WhatsAppCredentials.updateMany(
    { workspaceId, isActive: true, _id: { $ne: doc._id } },
    { $set: { isActive: false, status: "disconnected", disconnectedAt: now } }
  );
  await doc.updateOne({
    $set: {
      isActive: true,
      status: "active",
      isValid: true,
      connectedAt: doc.connectedAt || now,
      disconnectedAt: null,
    },
  });
  await markTemplatesStaleForInactiveWabas({ workspaceId, activeWabaId: doc.wabaId });
}

async function finalizeReadyState({ doc, workspace, actorUserId }) {
  const now = new Date();
  const warnings = [];
  const connection = buildConnectionContext(doc);

  await doc.updateOne({
    $set: {
      onboardingStage: ONBOARDING_STAGES.METADATA_SYNCING,
      lastMetaSyncAt: now,
      status: "pending",
    },
  });

  try {
    await syncConnectionMetadata(workspace.id, { connection });
    await doc.updateOne({
      $set: {
        onboardingStage: ONBOARDING_STAGES.METADATA_SYNCED,
      },
    });
  } catch (err) {
    warnings.push(sanitizeMetaError(err, "Metadata sync failed"));
    await doc.updateOne({
      $set: {
        onboardingStage: ONBOARDING_STAGES.SYNC_WARNING,
      },
    });
  }

  await doc.updateOne({
    $set: {
      onboardingStage: ONBOARDING_STAGES.TEMPLATE_SYNCING,
      templateSyncStatus: TEMPLATE_SYNC_STATUSES.IN_PROGRESS,
    },
  });

  try {
    await syncTemplatesForWorkspace({ workspace, connection });
    await doc.updateOne({
      $set: {
        templateSyncStatus: TEMPLATE_SYNC_STATUSES.COMPLETED,
        templateSyncCompletedAt: new Date(),
        onboardingStage: ONBOARDING_STAGES.TEMPLATE_SYNCED,
      },
    });
  } catch (err) {
    warnings.push(sanitizeMetaError(err, "Template sync failed"));
    await doc.updateOne({
      $set: {
        templateSyncStatus: TEMPLATE_SYNC_STATUSES.FAILED,
        templateSyncLastError: sanitizeMetaError(err, "Template sync failed"),
        onboardingStage: ONBOARDING_STAGES.SYNC_WARNING,
      },
    });
  }

  const finalStage = warnings.length ? ONBOARDING_STAGES.READY_WITH_WARNINGS : ONBOARDING_STAGES.READY;
  await activateReadyConnection({ doc, workspaceId: String(workspace.id) });
  await doc.updateOne({
    $set: {
      onboardingStage: finalStage,
      status: "active",
      isValid: true,
      metadataWarnings: warnings.filter(Boolean),
    },
  });

  await logWorkspaceActivity({
    workspaceId: workspace.id,
    actorUserId: actorUserId || null,
    action: "whatsapp.connected",
    entityType: "whatsapp_connection",
    entityId: doc.wabaId,
    metadata: { maskedWabaId: maskId(doc.wabaId), maskedPhoneNumberId: maskId(doc.phoneNumberId) },
  });

  return { warnings, finalStage };
}

async function performPhoneRegistration({ doc, pin }) {
  if (String(doc.registrationStatus || "") === REGISTRATION_STATUSES.COMPLETED) {
    return { success: true, attemptCount: 0, skipped: true };
  }

  await ensureRegistrationWindowOpen(doc);

  const now = new Date();
  await doc.updateOne({
    $set: {
      onboardingStage: ONBOARDING_STAGES.REGISTERING,
      registrationStatus: REGISTRATION_STATUSES.REGISTERING,
      phoneRegistrationState: REGISTRATION_STATUSES.REGISTERING,
      registrationLastAttemptAt: now,
      phoneRegistrationPinEnc: pin ? encryptPin(pin) : doc.phoneRegistrationPinEnc,
      phoneRegistrationPinUpdatedAt: pin ? now : doc.phoneRegistrationPinUpdatedAt || null,
      registrationLastError: null,
      registrationLastErrorCode: null,
      registrationRetryAllowed: null,
      registrationRetryAfterAt: null,
      registrationRecommendedAction: null,
      lastError: null,
      status: "pending",
    },
  });

  try {
    const embeddedAccessToken = doc.accessTokenEnc ? decryptString(doc.accessTokenEnc) : "";
    if (!embeddedAccessToken) {
      throw new HttpError(500, "Missing embedded signup access token for phone registration.");
    }
    const registration = await registerPhoneNumber({
      accessToken: embeddedAccessToken,
      phoneNumberId: String(doc.phoneNumberId),
      pin,
      graphApiVersion: doc.graphApiVersion,
    });
    const completedAt = new Date();
    await doc.updateOne({
      $set: {
        onboardingStage: ONBOARDING_STAGES.PHONE_REGISTERED,
        registrationStatus: REGISTRATION_STATUSES.COMPLETED,
        phoneRegistrationState: REGISTRATION_STATUSES.COMPLETED,
        registrationCompletedAt: completedAt,
        registrationLastAttemptAt: completedAt,
        registrationLastError: null,
        registrationLastErrorCode: null,
        registrationRetryAllowed: false,
        registrationRetryAfterAt: null,
        registrationRecommendedAction: null,
        registrationExpired: false,
      },
      $inc: { registrationRetryCount: Math.max(0, Number(registration?.attemptCount || 1) - 1) },
    });
    return registration;
  } catch (err) {
    const registrationError = classifyRegistrationError(err);
    await doc.updateOne({
      $set: {
        status: "failed",
        onboardingStage: ONBOARDING_STAGES.FAILED,
        registrationStatus: REGISTRATION_STATUSES.FAILED,
        phoneRegistrationState: REGISTRATION_STATUSES.FAILED,
        registrationLastAttemptAt: new Date(),
        registrationLastError: registrationError.message || "Phone registration failed",
        registrationLastErrorCode: registrationError.code != null ? String(registrationError.code) : null,
        registrationRetryAllowed: Boolean(registrationError.retryable),
        registrationRetryAfterAt: registrationError.retryAfterAt || null,
        registrationRecommendedAction: registrationError.recommendedAction || null,
      },
      $inc: { registrationRetryCount: 1 },
    });
    throw err;
  }
}

async function executeEmbeddedSignupExchange({
  workspace,
  user,
  code,
  wabaId,
  phoneNumberId,
  pin,
  flowId = null,
}) {
  const workspaceId = workspace?.id ? String(workspace.id) : "";
  const codeFingerprint = fingerprint(code);
  const logContext = {
    workspaceId: workspaceId || null,
    flowId: flowId ? String(flowId) : null,
    codeFingerprint,
    wabaId: maskId(wabaId),
    phoneNumberId: maskId(phoneNumberId),
  };
  const cacheKey = buildExchangeCacheKey({ workspaceId, code });

  console.info("[meta-embedded-signup] exchange requested", logContext);

  return runDedupedExchange({ cacheKey, logContext }, async () => {
    let token;
    let appId;
    try {
      const exchanged = await exchangeCodeForToken(code);
      token = exchanged.token;
      appId = exchanged.appId;
      console.info("[meta-embedded-signup] code exchange succeeded", logContext);
    } catch (err) {
      if (isUsedAuthorizationCodeError(err)) {
        const recovered = await recoverExistingEmbeddedSignupSession({
          workspaceId: workspace?.id,
          wabaId,
          phoneNumberId,
        });
        if (recovered) {
          console.info("[meta-embedded-signup] used code recovered existing signup session", {
            ...logContext,
            recoveredConnectionId: recovered.connectionId,
            recoveredLifecycleState: recovered.lifecycleState,
            recoveredRegistrationStatus: recovered.registrationStatus,
          });
          return recovered;
        }

        const existingState = await inspectExistingEmbeddedSignupState({
          workspaceId: workspace?.id,
        });
        console.warn("[meta-embedded-signup] used code could not be resumed", {
          ...logContext,
          existingState,
        });
        throw buildMetaStepError(err, {
          step: "exchange_code_for_token",
          endpoint: "/oauth/access_token",
          tokenType: META_TOKEN_TYPES.APP_ACCESS,
          message: "Meta authorization code was already used. Start a fresh WhatsApp connect attempt.",
          workspaceId: workspace?.id,
          extraDetails: {
            restartRequired: true,
            recoveryAttempted: true,
            existingState,
            debugHint:
              "Search backend logs for this codeFingerprint to find the earlier step that consumed the Meta code.",
            flowId: flowId ? String(flowId) : null,
            codeFingerprint,
          },
        });
      }
      throw buildMetaStepError(err, {
        step: "exchange_code_for_token",
        endpoint: "/oauth/access_token",
        tokenType: META_TOKEN_TYPES.APP_ACCESS,
        message: "Meta code exchange failed.",
        workspaceId: workspace?.id,
        extraDetails: {
          flowId: flowId ? String(flowId) : null,
          codeFingerprint,
        },
      });
    }
    const graphApiVersion = getMetaGraphVersion();
    const debugTokenData = await debugBusinessToken({
      token,
      graphApiVersion,
    }).catch((err) => {
      throw buildMetaStepError(err, {
        step: "debug_business_token",
        endpoint: "/debug_token",
        tokenType: META_TOKEN_TYPES.SYSTEM_USER,
        message: "Meta token validation failed.",
        workspaceId: workspace?.id,
        extraDetails: {
          flowId: flowId ? String(flowId) : null,
          codeFingerprint,
        },
      });
    });
    validateTokenScopes(debugTokenData, wabaId, appId);
    console.info("[meta-embedded-signup] token validated", {
      ...logContext,
      appId: maskId(appId),
    });

    const client = createMetaClient({ graphApiVersion, timeout: 20000 });
    const provisioning = await ensureSystemUserProvisionedOnWaba({
      wabaId,
      graphApiVersion,
      customerAccessToken: token,
    }).catch((err) => {
      console.warn("[meta-embedded-signup] optional system-user provisioning skipped", {
        step: "provision_waba_system_user",
        endpoint: `/${wabaId}/assigned_users`,
        workspaceId: workspace?.id ? String(workspace.id) : null,
        flowId: flowId ? String(flowId) : null,
        codeFingerprint,
        message: err?.message || "Unknown error",
        details: err?.details || null,
      });
      return {
        businessManagerId: null,
        wabaName: null,
        systemUserId: null,
        provisioningSkipped: true,
      };
    });

    const { matchedPhone, phones } = await discoverPhoneNumber({
      wabaId,
      phoneNumberId,
      graphApiVersion,
      accessToken: token,
    }).catch((err) => {
      throw buildMetaStepError(err, {
        step: "discover_phone_number",
        endpoint: `/${wabaId}/phone_numbers`,
        tokenType: META_TOKEN_TYPES.EMBEDDED_SIGNUP_CUSTOMER,
        message: "Meta phone discovery failed.",
        workspaceId: workspace?.id,
        extraDetails: { wabaId, flowId: flowId ? String(flowId) : null, codeFingerprint },
      });
    });
    console.info("[meta-embedded-signup] phone discovery completed", {
      ...logContext,
      matchedPhoneId: matchedPhone?.id ? maskId(matchedPhone.id) : null,
      availablePhones: Array.isArray(phones) ? phones.length : 0,
    });

    if (!matchedPhone) {
      console.warn("[meta-embedded-signup] phone discovery returned no matched phone", {
        ...logContext,
        availablePhones: Array.isArray(phones) ? phones.length : 0,
      });
      return {
        success: false,
        needsPhoneSelection: true,
        lifecycleState: ONBOARDING_STAGES.PHONE_DISCOVERED,
        message: "Meta did not return a phone number. Please select a phone number and reconnect WhatsApp.",
        phones: phones.map((item) => ({
          id: String(item?.id || "").trim(),
          display_phone_number: String(item?.display_phone_number || "").trim() || null,
        })),
      };
    }

    await ensureWebhookSubscription({
      client,
      accessToken: token,
      wabaId,
    }).catch((err) => {
      if (err?.statusCode) {
        console.error("[meta-embedded-signup] step failed", {
          step: "subscribe_waba_webhook",
          endpoint: `/${wabaId}/subscribed_apps`,
          tokenType: META_TOKEN_TYPES.EMBEDDED_SIGNUP_CUSTOMER,
          workspaceId: workspace?.id ? String(workspace.id) : null,
          flowId: flowId ? String(flowId) : null,
          codeFingerprint,
          message: err.message,
          details: err.details || null,
        });
        throw err;
      }
      throw buildMetaStepError(err, {
        step: "subscribe_waba_webhook",
        endpoint: `/${wabaId}/subscribed_apps`,
        tokenType: META_TOKEN_TYPES.EMBEDDED_SIGNUP_CUSTOMER,
        message: "Meta webhook subscription failed.",
        workspaceId: workspace?.id,
        extraDetails: { wabaId, flowId: flowId ? String(flowId) : null, codeFingerprint },
      });
    });
    console.info("[meta-embedded-signup] webhook subscription confirmed", logContext);

    const registrationStatus = pin ? REGISTRATION_STATUSES.REGISTERING : REGISTRATION_STATUSES.PIN_REQUIRED;
    const onboardingStage = pin ? ONBOARDING_STAGES.REGISTERING : ONBOARDING_STAGES.PIN_REQUIRED;

    const connection = await persistOnboardingConnection({
      workspaceId: String(workspace.id),
      userId: user?.id || null,
      accessToken: token,
      wabaId,
      phoneNumber: matchedPhone,
      debugTokenData,
      subscribed: true,
      onboardingStage,
      registrationStatus,
      pin,
      businessManagerId: provisioning.businessManagerId,
      wabaName: provisioning.wabaName,
    });

    console.info("[meta-embedded-signup] onboarding connection persisted", {
      ...logContext,
      connectionId: String(connection._id),
      lifecycleState: onboardingStage,
      registrationStatus,
    });

    if (!pin) {
      return {
        success: true,
        connected: false,
        status: "pending",
        requiresPinSetup: true,
        connectionId: String(connection._id),
        lifecycleState: ONBOARDING_STAGES.PIN_REQUIRED,
        onboardingStage: ONBOARDING_STAGES.PIN_REQUIRED,
        registrationStatus: REGISTRATION_STATUSES.PIN_REQUIRED,
        embeddedSignupCompletedAt: connection.embeddedSignupCompletedAt,
        registrationDeadlineAt: connection.registrationDeadlineAt,
      };
    }

    await performPhoneRegistration({ doc: connection, pin });
    const { finalStage } = await finalizeReadyState({ doc: connection, workspace, actorUserId: user?.id || null });
    return {
      success: true,
      connected: true,
      status: "active",
      lifecycleState: finalStage,
      registrationStatus: REGISTRATION_STATUSES.COMPLETED,
      onboardingStage: finalStage,
    };
  });
}

async function retryPhoneRegistration({
  workspace,
  pin,
  actorUserId,
}) {
  const doc = await findLatestConnectionDocument(
    workspace.id,
    "+accessTokenEnc +phoneRegistrationPinEnc +businessAccountIdEnc +phoneNumberIdEnc graphApiVersion phoneNumberId wabaId onboardingStage registrationStatus phoneRegistrationState phoneRegistrationPinUpdatedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired",
    { onlyEmbeddedSignup: true }
  );
  if (!doc) throw new HttpError(404, "WhatsApp onboarding record not found");

  if (String(doc.registrationStatus || "") === REGISTRATION_STATUSES.COMPLETED) {
    if (![ONBOARDING_STAGES.READY, ONBOARDING_STAGES.READY_WITH_WARNINGS].includes(String(doc.onboardingStage || ""))) {
      await finalizeReadyState({ doc, workspace, actorUserId });
    }
    return doc;
  }

  const resolvedPin = pin || (doc.phoneRegistrationPinEnc ? decryptPin(doc.phoneRegistrationPinEnc) : "");
  if (!resolvedPin) {
    await doc.updateOne({
      $set: {
        onboardingStage: ONBOARDING_STAGES.PIN_REQUIRED,
        registrationStatus: REGISTRATION_STATUSES.PIN_REQUIRED,
        phoneRegistrationState: REGISTRATION_STATUSES.PIN_REQUIRED,
      },
    });
    throw new HttpError(400, "A registration PIN is required before the phone can be registered.");
  }

  await ensureRegistrationWindowOpen(doc);
  await performPhoneRegistration({ doc, pin: resolvedPin });
  await finalizeReadyState({ doc, workspace, actorUserId });
  return doc;
}

async function changeEmbeddedSignupPin({
  workspace,
  pin,
  actorUserId,
}) {
  const doc = await findLatestConnectionDocument(
    workspace.id,
    "+accessTokenEnc +phoneRegistrationPinEnc +businessAccountIdEnc +phoneNumberIdEnc graphApiVersion phoneNumberId wabaId onboardingStage registrationStatus phoneRegistrationState phoneRegistrationPinUpdatedAt embeddedSignupCompletedAt registrationDeadlineAt registrationExpired",
    { onlyEmbeddedSignup: true }
  );
  if (!doc) throw new HttpError(404, "WhatsApp onboarding record not found");

  const embeddedAccessToken = doc.accessTokenEnc ? decryptString(doc.accessTokenEnc) : "";
  if (!embeddedAccessToken) {
    throw new HttpError(500, "Missing embedded signup access token for PIN change.");
  }

  await changeTwoStepVerificationPin({
    accessToken: embeddedAccessToken,
    phoneNumberId: String(doc.phoneNumberId),
    pin,
    graphApiVersion: doc.graphApiVersion,
  });

  const now = new Date();
  await doc.updateOne({
    $set: {
      phoneRegistrationPinEnc: encryptPin(pin),
      phoneRegistrationPinUpdatedAt: now,
      registrationLastError: null,
      registrationLastErrorCode: null,
      registrationRetryAllowed: true,
      registrationRetryAfterAt: null,
      registrationRecommendedAction: "Use the updated PIN to finish WhatsApp phone registration.",
      lastEditedAt: now,
      lastEditedBy: actorUserId || null,
    },
  });

  return doc;
}

module.exports = {
  changeEmbeddedSignupPin,
  executeEmbeddedSignupExchange,
  retryPhoneRegistration,
};
