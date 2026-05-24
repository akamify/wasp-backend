const Joi = require("joi");
const { HttpError } = require("@shared/utils/httpError");
const workspaceFeatureService = require("@modules/workspaces/services/workspaceFeature.service");

const paramsSchema = Joi.object({
  workspaceId: Joi.string().hex().length(24).required(),
});

async function updateExternalChatFeature(req, res) {
  const { workspaceId } = await paramsSchema.validateAsync(req.params, {
    abortEarly: false,
    stripUnknown: true,
  });

  const body = await workspaceFeatureService.toggleExternalChatFeature({
    req,
    workspaceId,
    payload: req.body,
  });

  res.json(body);
}

async function getExternalChatFeature(req, res) {
  const { workspaceId } = await paramsSchema.validateAsync(req.params, {
    abortEarly: false,
    stripUnknown: true,
  });

  const body = await workspaceFeatureService.getExternalChatFeature({ workspaceId });
  res.json(body);
}

module.exports = {
  updateExternalChatFeature,
  getExternalChatFeature,
};
