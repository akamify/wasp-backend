const express = require("express");
const { auth } = require("@core/middleware/auth");
const { authOrApiKey } = require("@core/middleware/authOrApiKey");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { campaignsController } = require("@modules/campaigns/controllers/index");
const { createSchema, estimateSchema, actionSchema } = require("@modules/campaigns/validations/index");

const router = express.Router();

router.get("/", auth, requireWorkspace, asyncHandler(campaignsController.listCampaigns));
router.get("/:id", auth, requireWorkspace, asyncHandler(campaignsController.getCampaign));
router.get("/:id/metrics", auth, requireWorkspace, asyncHandler(campaignsController.getCampaignMetrics));
router.get("/:id/messages", auth, requireWorkspace, asyncHandler(campaignsController.listCampaignMessages));
router.get("/:id/replies", auth, requireWorkspace, asyncHandler(campaignsController.listCampaignReplies));
router.get("/:id/credit-usage", auth, requireWorkspace, asyncHandler(campaignsController.getCampaignCreditUsage));
router.get("/:id/failed-recipients", auth, requireWorkspace, asyncHandler(campaignsController.listFailedRecipients));
router.post("/:id/retry-failed", auth, requireWorkspace, asyncHandler(campaignsController.retryFailedCampaign));
router.delete("/:id", auth, requireWorkspace, asyncHandler(campaignsController.deleteCampaign));
router.post("/:id/action", auth, requireWorkspace, validate(actionSchema), asyncHandler(campaignsController.updateCampaignStatus));
router.post("/estimate", authOrApiKey, requireWorkspace, validate(estimateSchema), asyncHandler(campaignsController.estimateCampaign));
router.post("/", authOrApiKey, requireWorkspace, validate(createSchema), asyncHandler(campaignsController.createCampaign));

module.exports = router;
