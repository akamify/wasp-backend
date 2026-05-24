const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { listApiCampaignReports, getApiCampaignReport } = require("@modules/reports/controllers/reports.controller");
const { listApiMessages, getApiMessageDetail } = require("@modules/reports/controllers/apiReport.controller");
const Joi = require("joi");
const { validate } = require("@core/middleware/validate");

const router = express.Router();
const requireApiReportsAccess = requireBillingFeature("apiReportsPageAccess", {
  message: "Your current plan does not include API reports access.",
});

router.get("/api-campaigns", auth, requireWorkspace, requireApiReportsAccess, asyncHandler(listApiCampaignReports));
router.get("/api-campaigns/:id", auth, requireWorkspace, requireApiReportsAccess, asyncHandler(getApiCampaignReport));

router.get(
  "/api-messages",
  auth,
  requireWorkspace,
  requireApiReportsAccess,
  validate(
    Joi.object({
      page: Joi.number().integer().min(1).optional(),
      limit: Joi.number().integer().min(1).max(100).optional(),
      sort: Joi.string().valid("asc", "desc").optional(),
      status: Joi.string().optional(),
      search: Joi.string().max(200).allow("").optional(),
      templateId: Joi.string().optional(),
      campaignId: Joi.string().optional(),
      dateFrom: Joi.date().iso().optional(),
      dateTo: Joi.date().iso().optional(),
      onlyApiCampaigns: Joi.string().valid("true", "false").optional(),
    }).unknown(true)
  ),
  asyncHandler(listApiMessages)
);

router.get("/api-messages/:id", auth, requireWorkspace, requireApiReportsAccess, asyncHandler(getApiMessageDetail));

module.exports = router;

