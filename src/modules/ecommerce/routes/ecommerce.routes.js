const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const rateLimiters = require("@core/middleware/rateLimiters");
const controller = require("@modules/ecommerce/controllers/ecommerce.controller");
const {
  createStoreSchema,
  customTestEventSchema,
  otpSchema,
  platformQuerySchema,
  shopifyConnectStartSchema,
  updateStoreSchema,
} = require("@modules/ecommerce/validators/ecommerce.validators");

const router = express.Router();

const read = [auth, requireWorkspace, requireWorkspacePermission("ecommerce.view")];
const manage = [auth, requireWorkspace, requireWorkspacePermission("ecommerce.manage")];

router.get("/integrations/platforms", ...read, rateLimiters.ecommerceRead, asyncHandler(controller.listPlatforms));
router.get("/stores", ...read, rateLimiters.ecommerceRead, validate(platformQuerySchema, "query"), asyncHandler(controller.listStores));
router.post("/stores", ...manage, rateLimiters.ecommerceConnect, validate(createStoreSchema), asyncHandler(controller.createStore));
router.post("/shopify/connect/start", ...manage, rateLimiters.ecommerceConnect, validate(shopifyConnectStartSchema), asyncHandler(controller.startShopifyConnect));
router.get("/shopify/install", rateLimiters.ecommerceConnect, asyncHandler(controller.continueShopifyInstall));
router.get("/shopify/callback", rateLimiters.ecommerceConnect, asyncHandler(controller.completeShopifyConnect));
router.patch("/stores/:storeId", ...manage, rateLimiters.ecommerceConnect, validate(updateStoreSchema), asyncHandler(controller.updateStore));
router.post("/stores/:storeId/reconnect", ...manage, rateLimiters.ecommerceConnect, asyncHandler(controller.reconnectStore));
router.post("/stores/:storeId/pause", ...manage, rateLimiters.ecommerceConnect, asyncHandler(controller.pauseStore));
router.post("/stores/:storeId/resume", ...manage, rateLimiters.ecommerceConnect, asyncHandler(controller.resumeStore));
router.post("/stores/:storeId/disconnect", ...manage, rateLimiters.ecommerceConnect, asyncHandler(controller.disconnectStore));
router.post("/stores/:storeId/revoke", ...manage, rateLimiters.ecommerceConnect, asyncHandler(controller.revokeCustomStore));
router.post("/stores/:storeId/custom/secret/request-otp", ...manage, rateLimiters.otp, asyncHandler(controller.requestCustomSecretOtp));
router.post("/stores/:storeId/custom/secret/rotate", ...manage, rateLimiters.otp, validate(otpSchema), asyncHandler(controller.rotateCustomSecret));
router.post("/stores/:storeId/custom/test-event", ...manage, rateLimiters.ecommerceConnect, validate(customTestEventSchema), asyncHandler(controller.sendCustomTestEvent));
router.delete("/stores/:storeId", ...manage, rateLimiters.ecommerceConnect, asyncHandler(controller.deleteStore));
router.get("/stores/:storeId/health", ...read, rateLimiters.ecommerceRead, asyncHandler(controller.getHealth));
router.get("/stores/:storeId/webhooks", ...read, rateLimiters.ecommerceRead, asyncHandler(controller.getWebhooks));
router.get("/stores/:storeId/events", ...read, rateLimiters.ecommerceRead, asyncHandler(controller.getEvents));
router.post("/webhooks/woocommerce/:storeId", rateLimiters.ecommerceWebhook, asyncHandler(controller.receiveWooCommerceWebhook));
router.post("/webhooks/shopify", rateLimiters.ecommerceWebhook, asyncHandler(controller.receiveShopifyWebhook));
router.post("/webhooks/custom/:storeId", rateLimiters.ecommerceWebhook, asyncHandler(controller.receiveCustomWebhook));

module.exports = router;
