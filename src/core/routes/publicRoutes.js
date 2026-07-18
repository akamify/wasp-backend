const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { getPublicPage, createSupportTicket, createDocsFeedback, applyCareer, getPublicPlatformBrand } = require("@modules/public/controllers/publicContent.controller");
const { pixelScript, publicCollect, publicOptions } = require("@modules/conversions/controllers/conversion.controller");
const { academyHome, academyArticle, academySearch, academyRelated } = require("@modules/public/controllers/publicDocs.controller");
const liveDemoController = require("@modules/live-demo/controllers/liveDemo.controller");
const { createLiveDemoSchema } = require("@modules/live-demo/validations/liveDemo.validation");
const { validate } = require("@core/middleware/validate");

const router = express.Router();

router.get("/pages/:slug", asyncHandler(getPublicPage));
router.get("/platform-brand", asyncHandler(getPublicPlatformBrand));
router.get("/academy", asyncHandler(academyHome));
router.get("/academy/search", asyncHandler(academySearch));
router.get("/academy/:categorySlug/:articleSlug", asyncHandler(academyArticle));
router.get("/academy/:categorySlug/:articleSlug/related", asyncHandler(academyRelated));
router.options("/conversions/collect", publicOptions);
router.get("/pixel.js", asyncHandler(pixelScript));
router.post("/conversions/collect", asyncHandler(publicCollect));
router.post("/docs/feedback", asyncHandler(createDocsFeedback));
router.post("/support-tickets", asyncHandler(createSupportTicket));
router.get("/live-demo/slots", asyncHandler(liveDemoController.publicSlots));
router.post("/live-demo", validate(createLiveDemoSchema), asyncHandler(liveDemoController.publicCreate));

const resumeUpload = buildMemoryUpload({
  maxFileSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
});
router.post("/careers/apply", resumeUpload.single("resume"), asyncHandler(applyCareer));

module.exports = router;


