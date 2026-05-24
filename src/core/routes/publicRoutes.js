const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { getPublicPage, createSupportTicket, applyCareer, getPublicPlatformBrand } = require("@modules/public/controllers/publicContent.controller");

const router = express.Router();

router.get("/pages/:slug", asyncHandler(getPublicPage));
router.get("/platform-brand", asyncHandler(getPublicPlatformBrand));
router.post("/support-tickets", asyncHandler(createSupportTicket));

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


