const DEFAULT_FLOW_RUNTIME_SETTINGS = Object.freeze({
  sessionTimeoutMinutes: 30,
  onSessionExpired: Object.freeze({
    action: "none",
    textMessage:
      "Your previous session has expired. Please send Hi to start again.",
    templateName: "",
    languageCode: "en",
    variables: Object.freeze([]),
  }),
  allowKeywordRestartWhenWaiting: true,
});

function normalizeRuntimeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  const expiry =
    settings.onSessionExpired &&
    typeof settings.onSessionExpired === "object"
      ? settings.onSessionExpired
      : {};
  const timeout = Number(settings.sessionTimeoutMinutes);
  return {
    sessionTimeoutMinutes:
      Number.isFinite(timeout) && timeout >= 1 && timeout <= 10080
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
    },
    allowKeywordRestartWhenWaiting:
      settings.allowKeywordRestartWhenWaiting !== false,
  };
}

function sessionExpiresAt(runtimeSettings, now = new Date()) {
  const settings = normalizeRuntimeSettings(runtimeSettings);
  return new Date(
    now.getTime() + settings.sessionTimeoutMinutes * 60 * 1000
  );
}

module.exports = {
  DEFAULT_FLOW_RUNTIME_SETTINGS,
  normalizeRuntimeSettings,
  sessionExpiresAt,
};
