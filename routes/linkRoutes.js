const express = require("express");
const Joi = require("joi");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../utils/asyncHandler");
const { createLink } = require("../controllers/linkController");

const router = express.Router();

router.post(
  "/",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      url: Joi.string().required(),
      templateId: Joi.string().optional(),
      messageId: Joi.string().optional(),
    })
  ),
  asyncHandler(createLink)
);

module.exports = router;

