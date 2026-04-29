const express = require("express");
const Joi = require("joi");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../utils/asyncHandler");
const { listCampaigns, createCampaign } = require("../controllers/campaignController");

const router = express.Router();

router.get("/", auth, requireWorkspace, asyncHandler(listCampaigns));
router.post(
  "/",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      name: Joi.string().trim().min(2).max(140).required(),
      templateId: Joi.string().required(),
      recipients: Joi.array().items(Joi.string().min(8).max(30)).min(1).max(50000).required(),
      scheduledAt: Joi.date().iso().optional(),
    })
  ),
  asyncHandler(createCampaign)
);

module.exports = router;

