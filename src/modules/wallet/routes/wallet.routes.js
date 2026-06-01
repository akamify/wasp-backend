const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { walletController } = require("@modules/wallet/controllers/index");
const { walletValidation } = require("@modules/wallet/validations/index");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();

router.get("/", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(walletController.getWallet));
router.get("/history", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(walletController.walletHistory));
router.post("/recharge/order", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(walletValidation.rechargeOrderSchema), asyncHandler(walletController.createRechargeOrder));

module.exports = router;

