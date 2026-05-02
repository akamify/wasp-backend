const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const rateLimiters = require("../middleware/rateLimiters");
const { auth } = require("../middleware/auth");
const { register, login, me, rotateApiKey, updateProfile } = require("../controllers/authController");

const router = express.Router();

router.post(
  "/register",
  rateLimiters.auth,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
      name: Joi.string().max(120).allow("", null),
      phone: Joi.string().max(40).allow("", null),
    })
  ),
  asyncHandler(register)
);

router.post(
  "/login",
  rateLimiters.auth,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().required(),
    })
  ),
  asyncHandler(login)
);

router.get("/me", auth, asyncHandler(me));
router.post("/api-key/rotate", auth, asyncHandler(rotateApiKey));
router.put(
  "/profile",
  auth,
  validate(
    Joi.object({
      name: Joi.string().max(120).allow("", null).optional(),
      phone: Joi.string().max(40).allow("", null).optional(),
    })
  ),
  asyncHandler(updateProfile)
);

module.exports = router;

