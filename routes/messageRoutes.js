const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const {
  sendTemplate,
  bulkSend,
  listLogs,
  messagesByPhone,
} = require("../controllers/messageController");

const router = express.Router();

router.post(
  "/send",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      templateId: Joi.string().required(),
      to: Joi.string().min(8).max(20).required(),
      languageCode: Joi.string().min(2).max(20).optional(),

      // For utility / marketing
      variables: Joi.array().items(Joi.string().allow("")).optional(),
      headerVariables: Joi.array().items(Joi.string().allow("")).optional(),

      // For authentication
      otpCode: Joi.string().trim().min(1).optional(),

      buttonValues: Joi.array().items(Joi.string().allow("")).optional(),
    })
  ),
  asyncHandler(sendTemplate)
);

router.post(
  "/bulk",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      templateId: Joi.string().required(),
      languageCode: Joi.string().min(2).max(20).optional(),
      concurrency: Joi.number().integer().min(1).max(20).optional(),
      recipients: Joi.array()
        .items(
          Joi.object({
            to: Joi.string().min(8).max(20).required(),
            variables: Joi.array().items(Joi.string().allow("")).optional(),
            headerVariables: Joi.array().items(Joi.string().allow("")).optional(),
            otpCode: Joi.string().trim().min(1).optional(),
            buttonValues: Joi.array().items(Joi.string().allow("")).optional(),
          }).required()
        )
        .min(1)
        .required(),
    })
  ),
  asyncHandler(bulkSend)
);

router.get("/logs", auth, requireWorkspace, asyncHandler(listLogs));
router.get("/:phone", auth, requireWorkspace, asyncHandler(messagesByPhone));

module.exports = router;
