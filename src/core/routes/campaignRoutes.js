const express = require("express");
const { auth } = require("@core/middleware/auth");
const { authOrApiKey } = require("@core/middleware/authOrApiKey");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireApiPermission } = require("@modules/api-keys/middleware/requireApiPermission");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const {
  actionSchema,
  createSchema,
  estimateSchema,
} = require("@modules/campaigns/validations/campaigns.validation");
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
  validate(actionSchema),
  asyncHandler(updateCampaignStatus)
);
router.post(
  "/estimate",
  authOrApiKey,
  requireWorkspace,
  requireWorkspacePermission("campaigns.send"),
  requireCampaignsAccess,
  requireApiPermission("campaignSend"),
  validate(estimateSchema),
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
  validate(createSchema),
  asyncHandler(createCampaign)
);

module.exports = router;

