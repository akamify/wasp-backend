const express = require("express");
const Joi = require("joi");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../utils/asyncHandler");
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
  deleteCampaign,
} = require("../controllers/campaignController");

const router = express.Router();

router.get("/", auth, requireWorkspace, asyncHandler(listCampaigns));
router.get("/:id", auth, requireWorkspace, asyncHandler(getCampaign));
router.get("/:id/metrics", auth, requireWorkspace, asyncHandler(getCampaignMetrics));
router.get("/:id/messages", auth, requireWorkspace, asyncHandler(listCampaignMessages));
router.get("/:id/replies", auth, requireWorkspace, asyncHandler(listCampaignReplies));
router.get("/:id/credit-usage", auth, requireWorkspace, asyncHandler(getCampaignCreditUsage));
router.post("/:id/retry-failed", auth, requireWorkspace, asyncHandler(retryFailedCampaign));
router.delete("/:id", auth, requireWorkspace, asyncHandler(deleteCampaign));
router.post(
  "/:id/action",
  auth,
  requireWorkspace,
  validate(Joi.object({ action: Joi.string().valid("pause", "resume", "stop").required() })),
  asyncHandler(updateCampaignStatus)
);
router.post(
  "/estimate",
  auth,
  requireWorkspace,
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
  auth,
  requireWorkspace,
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
        .min(1)
        .max(50000)
        .required(),
      scheduledAt: Joi.date().iso().optional(),
    })
  ),
  asyncHandler(createCampaign)
);

module.exports = router;

