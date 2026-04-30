const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const rateLimiters = require("../middleware/rateLimiters");
const { auth } = require("../middleware/auth");
const { register, login, me, rotateApiKey } = require("../controllers/authController");

const router = express.Router();

router.post(
  "/register",
  rateLimiters.auth,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
      name: Joi.string().max(120).allow("", null),
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

module.exports = router;

