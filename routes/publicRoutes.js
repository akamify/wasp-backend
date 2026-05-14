const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { buildMemoryUpload } = require("../utils/multerUpload");
const { getPublicPage, createSupportTicket, applyCareer } = require("../controllers/publicContentController");

const router = express.Router();

router.get("/pages/:slug", asyncHandler(getPublicPage));
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

