const preferencesRepository = require("@modules/preferences/repositories/preferences.repository");

const AUTOMATION_BUILDER_DEFAULTS = Object.freeze({
  leftSidebarCollapsed: false,
  rightSettingsOpen: true,
  leftSidebarWidth: 280,
  rightSettingsWidth: 360,
  lastActivePanel: "flow_settings",
  lastActiveLeftTab: "messages",
});

function normalizePreferences(value) {
  return {
    ...AUTOMATION_BUILDER_DEFAULTS,
    ...(value || {}),
  };
}

async function getAutomationBuilderPreferences({ userId, workspaceId }) {
  const record = await preferencesRepository.findPreference({
    userId,
    workspaceId,
    scope: "automation_builder",
  });
  return {
    ok: true,
    preferences: normalizePreferences(record?.preferences),
  };
}

async function updateAutomationBuilderPreferences({
  userId,
  workspaceId,
  preferences,
}) {
  const record = await preferencesRepository.upsertPreference({
    userId,
    workspaceId,
    scope: "automation_builder",
    preferences,
  });
  return {
    ok: true,
    preferences: normalizePreferences(record.preferences),
  };
}

module.exports = {
  AUTOMATION_BUILDER_DEFAULTS,
  getAutomationBuilderPreferences,
  updateAutomationBuilderPreferences,
};
