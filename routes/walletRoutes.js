const express = require("express");
const Joi = require("joi");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../utils/asyncHandler");
const { getWallet, createRechargeOrder, walletHistory } = require("../controllers/walletController");

const router = express.Router();

router.get("/", auth, requireWorkspace, asyncHandler(getWallet));
router.get("/history", auth, requireWorkspace, asyncHandler(walletHistory));
router.post(
  "/recharge/order",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      amount: Joi.number().positive().max(1000000).required(),
    })
  ),
  asyncHandler(createRechargeOrder)
);

module.exports = router;

