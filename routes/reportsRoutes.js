const express = require("express");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { asyncHandler } = require("../utils/asyncHandler");
const { listApiCampaignReports, getApiCampaignReport } = require("../controllers/reportsController");
const { listApiMessages, getApiMessageDetail } = require("../controllers/apiReportController");
const Joi = require("joi");
const { validate } = require("../middleware/validate");

const router = express.Router();

router.get("/api-campaigns", auth, requireWorkspace, asyncHandler(listApiCampaignReports));
router.get("/api-campaigns/:id", auth, requireWorkspace, asyncHandler(getApiCampaignReport));

router.get(
  "/api-messages",
  auth,
  requireWorkspace,
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

router.get("/api-messages/:id", auth, requireWorkspace, asyncHandler(getApiMessageDetail));

module.exports = router;
