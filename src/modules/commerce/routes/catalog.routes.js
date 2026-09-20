const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { HttpError } = require("@shared/utils/httpError");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const rateLimiters = require("@core/middleware/rateLimiters");
const { assertCatalogReady } = require("../services/catalogReadiness.service");
const controller = require("../controllers/catalog.controller");

const router = express.Router();
router.use(auth, requireWorkspace);
const permission = (name) => [requireWorkspacePermission(name), asyncHandler(async (_req, _res, next) => {
  await assertCatalogReady();
  next();
})];
const readCatalog = permission("commerce.catalog.view");
const manageCatalog = permission("commerce.catalog.manage");
const readProducts = permission("commerce.products.view");
const manageProducts = permission("commerce.products.manage");

router.get("/catalogs", ...readCatalog, rateLimiters.ecommerceRead, asyncHandler(controller.listCatalogs));
router.get("/catalog", ...readCatalog, rateLimiters.ecommerceRead, asyncHandler(controller.getCatalog));
router.get("/catalog/setup", ...manageCatalog, rateLimiters.ecommerceRead, asyncHandler(controller.catalogSetupStatus));
router.post("/catalog/create", ...manageCatalog, rateLimiters.ecommerceConnect, asyncHandler(controller.createCatalog));
router.put("/catalog", ...manageCatalog, rateLimiters.ecommerceConnect, asyncHandler(controller.bindCatalog));
router.patch("/catalog/settings", ...manageCatalog, rateLimiters.ecommerceConnect, asyncHandler(controller.changeCatalog("settings")));
router.post("/catalog/refresh", ...manageCatalog, rateLimiters.ecommerceConnect, asyncHandler(controller.changeCatalog("refresh")));
router.delete("/catalog", ...manageCatalog, rateLimiters.ecommerceConnect, asyncHandler(controller.changeCatalog("disconnect")));
router.get("/products", ...readProducts, rateLimiters.ecommerceRead, asyncHandler(controller.listProducts));
router.get("/products/:productId", ...readProducts, rateLimiters.ecommerceRead, asyncHandler(controller.getProduct));
router.post("/products", ...manageProducts, rateLimiters.ecommerceConnect, asyncHandler(controller.createProduct));
router.patch("/products/:productId", ...manageProducts, rateLimiters.ecommerceConnect, asyncHandler(controller.editProduct()));
router.post("/products/:productId/archive", ...manageProducts, rateLimiters.ecommerceConnect, asyncHandler(controller.editProduct(true)));
router.post("/products/:productId/sync", ...manageProducts, rateLimiters.ecommerceConnect, asyncHandler(controller.retryProduct));

const upload = buildMemoryUpload({ maxFileSizeBytes: 5 * 1024 * 1024, allowedMimeTypes: ["image/jpeg", "image/png"] }).single("file");
router.post("/images", ...manageProducts, rateLimiters.ecommerceConnect, (req, res, next) => {
  upload(req, res, (error) => next(error?.code === "LIMIT_FILE_SIZE" ? new HttpError(400, "Product image must be at most 5 MiB.") : error));
}, asyncHandler(controller.uploadImage));
module.exports = router;
