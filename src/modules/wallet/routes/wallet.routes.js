const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { walletController } = require("@modules/wallet/controllers/index");
const { walletValidation } = require("@modules/wallet/validations/index");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");

const router = express.Router();
const requireWalletAccess = requireBillingFeature("walletPageAccess", {
  message: "Your current plan does not include wallet access.",
});

router.get("/", auth, requireWorkspace, requireWalletAccess, requireWorkspacePermission("billing.view"), asyncHandler(walletController.getWallet));
router.get("/history", auth, requireWorkspace, requireWalletAccess, requireWorkspacePermission("billing.view"), asyncHandler(walletController.walletHistory));
router.post("/recharge/order", auth, requireWorkspace, requireWalletAccess, requireWorkspacePermission("billing.manage"), validate(walletValidation.rechargeOrderSchema), asyncHandler(walletController.createRechargeOrder));
router.post("/recharge/verify", auth, requireWorkspace, requireWalletAccess, requireWorkspacePermission("billing.manage"), validate(walletValidation.rechargeVerifySchema), asyncHandler(walletController.verifyRechargePayment));

module.exports = router;

