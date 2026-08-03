const {
  CONNECTION_STATUSES,
  ONBOARDING_STAGES,
  REGISTRATION_STATUSES,
  TEMPLATE_SYNC_STATUSES,
} = require("@modules/meta/constants/embeddedSignup.constants");

const SETUP_STEPS = [
  "CONNECT_META",
  "BUSINESS_CONNECTED",
  "PHONE_VERIFIED",
  "ENTER_PIN",
  "REGISTER_PHONE",
  "SYNC_METADATA",
  "SYNC_TEMPLATES",
  "READY",
];

function isReadyConnection(doc) {
  const stage = String(doc?.onboardingStage || "").trim();
  const legacyReady =
    String(doc?.status || "").toLowerCase() === "active" &&
    doc?.isActive !== false &&
    doc?.isValid === true &&
    !stage;
  return (
    legacyReady ||
    (
      String(doc?.status || "").toLowerCase() === "active" &&
      doc?.isActive !== false &&
      doc?.isValid === true &&
      String(doc?.registrationStatus || "") === REGISTRATION_STATUSES.COMPLETED &&
      [
        ONBOARDING_STAGES.READY,
        ONBOARDING_STAGES.READY_WITH_WARNINGS,
      ].includes(stage)
    )
  );
}

function inferRegistrationStatus(doc) {
  const explicit = String(doc?.registrationStatus || "").trim();
  if (explicit) return explicit;
  if (doc?.lastSuccessfulSendAt || doc?.registrationCompletedAt) return REGISTRATION_STATUSES.COMPLETED;
  if (doc?.registrationExpired) return REGISTRATION_STATUSES.EXPIRED;
  if (doc?.phoneRegistrationPinEnc) return REGISTRATION_STATUSES.PENDING;
  if (doc?.phoneNumberId || doc?.phoneNumberIdPlain) return REGISTRATION_STATUSES.PIN_REQUIRED;
  return REGISTRATION_STATUSES.NOT_STARTED;
}

function inferOnboardingStage(doc) {
  const explicit = String(doc?.onboardingStage || "").trim();
  if (explicit) return explicit;
  if (isReadyConnection(doc)) return ONBOARDING_STAGES.READY;
  if (doc?.registrationExpired) return ONBOARDING_STAGES.FAILED;
  if (doc?.templateSyncStatus === TEMPLATE_SYNC_STATUSES.COMPLETED) return ONBOARDING_STAGES.TEMPLATE_SYNCED;
  if (doc?.lastMetadataSyncAt || doc?.lastMetadataSyncAt === null ? doc?.metadataFetchStatus === "complete" : false) {
    return ONBOARDING_STAGES.METADATA_SYNCED;
  }
  if (inferRegistrationStatus(doc) === REGISTRATION_STATUSES.COMPLETED) return ONBOARDING_STAGES.PHONE_REGISTERED;
  if (doc?.webhookSubscribed) return ONBOARDING_STAGES.PHONE_REGISTRATION_PENDING;
  if (doc?.phoneNumberId || doc?.phoneNumberIdPlain) return ONBOARDING_STAGES.PHONE_DISCOVERED;
  if (doc?.wabaId || doc?.businessAccountIdPlain) return ONBOARDING_STAGES.WABA_DISCOVERED;
  return ONBOARDING_STAGES.NOT_STARTED;
}

function computeConnectionStatus(doc) {
  if (!doc || doc?.isActive === false) return CONNECTION_STATUSES.NOT_CONNECTED;
  const registrationStatus = inferRegistrationStatus(doc);
  const onboardingStage = inferOnboardingStage(doc);

  if (String(doc?.status || "").toLowerCase() === "failed" || registrationStatus === REGISTRATION_STATUSES.FAILED) {
    return CONNECTION_STATUSES.FAILED;
  }
  if (onboardingStage === ONBOARDING_STAGES.READY || isReadyConnection(doc)) {
    return CONNECTION_STATUSES.READY;
  }
  if (onboardingStage === ONBOARDING_STAGES.READY_WITH_WARNINGS) {
    return CONNECTION_STATUSES.READY;
  }
  if (onboardingStage === ONBOARDING_STAGES.TEMPLATE_SYNCED || onboardingStage === ONBOARDING_STAGES.METADATA_SYNCED) {
    return CONNECTION_STATUSES.SYNCING;
  }
  if (registrationStatus === REGISTRATION_STATUSES.COMPLETED) return CONNECTION_STATUSES.REGISTERED;
  if ([REGISTRATION_STATUSES.IN_PROGRESS, REGISTRATION_STATUSES.RETRYING, REGISTRATION_STATUSES.REGISTERING].includes(registrationStatus)) {
    return CONNECTION_STATUSES.REGISTERING;
  }
  if ([REGISTRATION_STATUSES.PIN_REQUIRED, REGISTRATION_STATUSES.PENDING].includes(registrationStatus)) {
    return CONNECTION_STATUSES.PENDING_REGISTRATION;
  }
  return CONNECTION_STATUSES.CONNECTING;
}

function computeRegistrationProgress(doc) {
  const completed = new Set();
  if (doc?.wabaId || doc?.businessAccountIdPlain) {
    completed.add("CONNECT_META");
    completed.add("BUSINESS_CONNECTED");
  }
  if (doc?.phoneNumberId || doc?.phoneNumberIdPlain) completed.add("PHONE_VERIFIED");
  if (doc?.phoneRegistrationPinEnc || inferRegistrationStatus(doc) !== REGISTRATION_STATUSES.PIN_REQUIRED) {
    completed.add("ENTER_PIN");
  }
  if (inferRegistrationStatus(doc) === REGISTRATION_STATUSES.COMPLETED) completed.add("REGISTER_PHONE");
  if (String(doc?.metadataFetchStatus || "") === "complete") completed.add("SYNC_METADATA");
  if (String(doc?.templateSyncStatus || "") === TEMPLATE_SYNC_STATUSES.COMPLETED) completed.add("SYNC_TEMPLATES");
  if (isReadyConnection(doc)) completed.add("READY");

  return {
    completedSteps: Array.from(completed),
    totalSteps: SETUP_STEPS.length,
    currentStep:
      SETUP_STEPS.find((step) => !completed.has(step)) || "READY",
    percent: Math.round((completed.size / SETUP_STEPS.length) * 100),
    steps: SETUP_STEPS.map((step) => ({
      key: step,
      state: completed.has(step) ? "complete" : step === SETUP_STEPS.find((item) => !completed.has(item)) ? "current" : "locked",
    })),
  };
}

module.exports = {
  computeConnectionStatus,
  computeRegistrationProgress,
  inferOnboardingStage,
  inferRegistrationStatus,
  isReadyConnection,
  SETUP_STEPS,
};
