const { asyncHandler } = require("@shared/utils/asyncHandler");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");

const requireAiAgentAccess = asyncHandler(async (req, _res, next) => {
  await aiAddonService.assertAiAddonAccess(req.workspace.id);
  next();
});

module.exports = { requireAiAgentAccess };
