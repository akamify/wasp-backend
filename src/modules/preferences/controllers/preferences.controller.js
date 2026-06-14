const preferencesService = require("@modules/preferences/services/preferences.service");

async function getAutomationBuilder(req, res) {
  res.json(
    await preferencesService.getAutomationBuilderPreferences({
      userId: req.user.id,
      workspaceId: req.workspace.id,
    })
  );
}

async function updateAutomationBuilder(req, res) {
  res.json(
    await preferencesService.updateAutomationBuilderPreferences({
      userId: req.user.id,
      workspaceId: req.workspace.id,
      preferences: req.body,
    })
  );
}

module.exports = {
  getAutomationBuilder,
  updateAutomationBuilder,
};
