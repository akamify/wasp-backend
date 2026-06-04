const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { authOrApiKey } = require("@core/middleware/authOrApiKey");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireApiPermission } = require("@modules/api-keys/middleware/requireApiPermission");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const {
  listCampaigns,
  getCampaign,
  createCampaign,
  estimateCampaign,
  getCampaignMetrics,
  listCampaignMessages,
  listCampaignReplies,
  getCampaignCreditUsage,
  updateCampaignStatus,
  retryFailedCampaign,
  listFailedRecipients,
  deleteCampaign,
} = require("@modules/campaigns/controllers/campaigns.controller");

const router = express.Router();
const requireCampaignsAccess = requireBillingFeature("campaignsPageAccess", {
  message: "Your current plan does not include campaigns access.",
});

router.get("/", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(listCampaigns));
router.get("/:id", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(getCampaign));
router.get("/:id/metrics", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(getCampaignMetrics));
router.get("/:id/messages", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(listCampaignMessages));
router.get("/:id/replies", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(listCampaignReplies));
router.get("/:id/credit-usage", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(getCampaignCreditUsage));
router.get("/:id/failed-recipients", auth, requireWorkspace, requireWorkspacePermission("campaigns.view"), requireCampaignsAccess, asyncHandler(listFailedRecipients));
router.post("/:id/retry-failed", auth, requireWorkspace, requireWorkspacePermission("campaigns.send"), requireCampaignsAccess, asyncHandler(retryFailedCampaign));
router.delete("/:id", auth, requireWorkspace, requireWorkspacePermission("campaigns.create"), requireCampaignsAccess, asyncHandler(deleteCampaign));
router.post(
  "/:id/action",
  auth,
  requireWorkspace,
  requireWorkspacePermission("campaigns.send"),
  requireCampaignsAccess,
  validate(Joi.object({ action: Joi.string().valid("pause", "resume", "stop", "complete").required() })),
  asyncHandler(updateCampaignStatus)
);
router.post(
  "/estimate",
  authOrApiKey,
  requireWorkspace,
  requireWorkspacePermission("campaigns.send"),
  requireCampaignsAccess,
  requireApiPermission("campaignSend"),
  validate(
    Joi.object({
      templateId: Joi.string().required(),
      recipients: Joi.array()
        .items(
          Joi.alternatives().try(
            Joi.string().min(8).max(30),
            Joi.object({
              to: Joi.string().min(8).max(30).required(),
              variables: Joi.array().items(Joi.string().allow("")).max(20).optional(),
              headerVariables: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              otpCode: Joi.string().allow("").max(20).optional(),
              buttonValues: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              buttonTtlMinutes: Joi.array().items(Joi.number().min(0).max(43200)).max(10).optional(),
              flowTokens: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              flowActionData: Joi.array().max(10).optional(),
            })
          )
        )
        .min(1)
        .max(50000)
        .required(),
    })
  ),
  asyncHandler(estimateCampaign)
);

router.post(
  "/",
  authOrApiKey,
  requireWorkspace,
  requireWorkspacePermission("campaigns.create"),
  requireWorkspacePermission("campaigns.send"),
  requireCampaignsAccess,
  requireApiPermission("campaignSend"),
  validate(
    Joi.object({
      name: Joi.string().trim().min(2).max(140).required(),
      type: Joi.string().valid("broadcast", "csv", "api").optional(),
      templateId: Joi.string().required(),
      recipients: Joi.array()
        .items(
          Joi.alternatives().try(
            Joi.string().min(8).max(30),
            Joi.object({
              to: Joi.string().min(8).max(30).required(),
              variables: Joi.array().items(Joi.string().allow("")).max(20).optional(),
              headerVariables: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              otpCode: Joi.string().allow("").max(20).optional(),
              buttonValues: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              buttonTtlMinutes: Joi.array().items(Joi.number().min(0).max(43200)).max(10).optional(),
              flowTokens: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              flowActionData: Joi.array().max(10).optional(),
            })
          )
        )
        .max(50000)
        .optional(),
      scheduledAt: Joi.date().iso().optional(),
      schedule: Joi.object({
        frequency: Joi.string().valid("once", "daily", "weekly").default("once"),
        endAt: Joi.date().iso().optional(),
        maxOccurrences: Joi.number().integer().min(1).max(365).optional(),
      }).optional(),
    })
  ),
  asyncHandler(createCampaign)
);

module.exports = router;

