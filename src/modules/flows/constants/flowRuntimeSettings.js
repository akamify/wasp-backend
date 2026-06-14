const DEFAULT_FLOW_RUNTIME_SETTINGS = Object.freeze({
  sessionTimeoutMinutes: 5,
  onSessionExpired: Object.freeze({
    action: "none",
    textMessage:
      "Your previous session has expired. Please send Hi to start again.",
    templateName: "",
    languageCode: "en",
    variables: Object.freeze([]),
    templateConfig: Object.freeze({ components: Object.freeze([]) }),
  }),
  allowKeywordRestartWhenWaiting: true,
  maxInvalidReplies: 2,
  invalidReplyMessage: "Please choose one of the available options.",
  staticVariables: Object.freeze({}),
});

function normalizeRuntimeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  const expiry =
    settings.onSessionExpired &&
    typeof settings.onSessionExpired === "object"
      ? settings.onSessionExpired
      : {};
  const timeout = Number(settings.sessionTimeoutMinutes);
  const maxInvalidReplies = Number(settings.maxInvalidReplies);
  return {
    sessionTimeoutMinutes:
      Number.isFinite(timeout) && timeout >= 1 && timeout <= 600
        ? Math.floor(timeout)
        : DEFAULT_FLOW_RUNTIME_SETTINGS.sessionTimeoutMinutes,
    onSessionExpired: {
      action: ["none", "text", "template"].includes(expiry.action)
        ? expiry.action
        : DEFAULT_FLOW_RUNTIME_SETTINGS.onSessionExpired.action,
      textMessage: String(
        expiry.textMessage ??
          DEFAULT_FLOW_RUNTIME_SETTINGS.onSessionExpired.textMessage
      ).trim(),
      templateName: String(expiry.templateName || "").trim(),
      languageCode: String(
        expiry.languageCode ||
          DEFAULT_FLOW_RUNTIME_SETTINGS.onSessionExpired.languageCode
      ).trim(),
      variables: Array.isArray(expiry.variables)
        ? expiry.variables.map((item) => String(item))
        : [],
      templateConfig:
        expiry.templateConfig &&
        typeof expiry.templateConfig === "object" &&
        !Array.isArray(expiry.templateConfig)
          ? expiry.templateConfig
          : { components: [] },
    },
    allowKeywordRestartWhenWaiting:
      settings.allowKeywordRestartWhenWaiting !== false,
    maxInvalidReplies:
      Number.isInteger(maxInvalidReplies) &&
      maxInvalidReplies >= 1 &&
      maxInvalidReplies <= 10
        ? maxInvalidReplies
        : DEFAULT_FLOW_RUNTIME_SETTINGS.maxInvalidReplies,
    invalidReplyMessage: String(
      settings.invalidReplyMessage ||
        DEFAULT_FLOW_RUNTIME_SETTINGS.invalidReplyMessage
    ).trim(),
    staticVariables:
      settings.staticVariables &&
      typeof settings.staticVariables === "object" &&
      !Array.isArray(settings.staticVariables)
        ? Object.fromEntries(
            Object.entries(settings.staticVariables).map(([key, value]) => [
              String(key || "").trim(),
              String(value ?? ""),
            ]).filter(([key]) => key)
          )
        : {},
  };
}

function sessionExpiresAt(runtimeSettings, now = new Date(), options = {}) {
  const settings = normalizeRuntimeSettings(runtimeSettings);
  const candidate = new Date(
    now.getTime() + settings.sessionTimeoutMinutes * 60 * 1000
  );
  const lastInboundAt = options.lastInboundAt
    ? new Date(options.lastInboundAt)
    : null;
  if (lastInboundAt && Number.isFinite(lastInboundAt.getTime())) {
    const cycleCap = new Date(lastInboundAt.getTime() + 600 * 60 * 1000);
    if (candidate.getTime() > cycleCap.getTime()) return cycleCap;
  }
  return candidate;
}

module.exports = {
  DEFAULT_FLOW_RUNTIME_SETTINGS,
  normalizeRuntimeSettings,
  sessionExpiresAt,
};
