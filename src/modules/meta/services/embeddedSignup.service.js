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
const { classifyRegistrationError, registerPhoneNumber } = require("@modules/meta/services/phoneRegistration.service");
const { syncConnectionMetadata } = require("@modules/meta/services/metadataSync.service");
const { syncTemplatesForWorkspace } = require("@modules/meta/services/templateSync.service");
const { decryptPin, encryptPin } = require("@modules/meta/services/pinLifecycle.service");
const { getToken, META_TOKEN_TYPES } = require("@modules/meta/services/tokenProvider.service");
const { ensureSystemUserProvisionedOnWaba } = require("@modules/meta/services/wabaProvisioning.service");
const { findLatestConnectionDocument } = require("@shared/services/whatsappConnectionService");

const REGISTRATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function maskId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
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

async function discoverPhoneNumber({ wabaId, phoneNumberId, graphApiVersion }) {
  const client = createMetaClient({ graphApiVersion, timeout: 20000 });
  const systemUserToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });
  const response = await client.get(`/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${systemUserToken}` },
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
  const systemUserToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });
  const connection = {
    ...buildConnectionContext(doc),
    accessToken: systemUserToken,
  };

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

  const systemUserToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });

  try {
    const registration = await registerPhoneNumber({
      accessToken: systemUserToken,
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
}) {
  const { token, appId } = await exchangeCodeForToken(code).catch((err) => {
    throw buildMetaStepError(err, {
      step: "exchange_code_for_token",
      endpoint: "/oauth/access_token",
      tokenType: META_TOKEN_TYPES.APP_ACCESS,
      message: "Meta code exchange failed.",
      workspaceId: workspace?.id,
    });
  });
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
    });
  });
  validateTokenScopes(debugTokenData, wabaId, appId);

  const { matchedPhone, phones } = await discoverPhoneNumber({
    wabaId,
    phoneNumberId,
    graphApiVersion,
  }).catch((err) => {
    throw buildMetaStepError(err, {
      step: "discover_phone_number",
      endpoint: `/${wabaId}/phone_numbers`,
      tokenType: META_TOKEN_TYPES.SYSTEM_USER,
      message: "Meta phone discovery failed.",
      workspaceId: workspace?.id,
      extraDetails: { wabaId },
    });
  });

  if (!matchedPhone) {
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

  const client = createMetaClient({ graphApiVersion, timeout: 20000 });
  const systemUserToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });
  const provisioning = await ensureSystemUserProvisionedOnWaba({
    wabaId,
    graphApiVersion,
  }).catch((err) => {
    if (err?.statusCode) {
      console.error("[meta-embedded-signup] step failed", {
        step: "provision_waba_system_user",
        endpoint: `/${wabaId}/assigned_users`,
        tokenType: META_TOKEN_TYPES.SYSTEM_USER,
        workspaceId: workspace?.id ? String(workspace.id) : null,
        message: err.message,
        details: err.details || null,
      });
      throw err;
    }
    throw buildMetaStepError(err, {
      step: "provision_waba_system_user",
      endpoint: `/${wabaId}/assigned_users`,
      tokenType: META_TOKEN_TYPES.SYSTEM_USER,
      message: "Meta WABA provisioning failed.",
      workspaceId: workspace?.id,
      extraDetails: { wabaId },
    });
  });
  await ensureWebhookSubscription({
    client,
    accessToken: systemUserToken,
    wabaId,
  }).catch((err) => {
    if (err?.statusCode) {
      console.error("[meta-embedded-signup] step failed", {
        step: "subscribe_waba_webhook",
        endpoint: `/${wabaId}/subscribed_apps`,
        tokenType: META_TOKEN_TYPES.SYSTEM_USER,
        workspaceId: workspace?.id ? String(workspace.id) : null,
        message: err.message,
        details: err.details || null,
      });
      throw err;
    }
    throw buildMetaStepError(err, {
      step: "subscribe_waba_webhook",
      endpoint: `/${wabaId}/subscribed_apps`,
      tokenType: META_TOKEN_TYPES.SYSTEM_USER,
      message: "Meta webhook subscription failed.",
      workspaceId: workspace?.id,
      extraDetails: { wabaId },
    });
  });

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

module.exports = {
  executeEmbeddedSignupExchange,
  retryPhoneRegistration,
};
