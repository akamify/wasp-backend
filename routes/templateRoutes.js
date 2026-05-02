const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  syncStatus,
  syncMetaTemplates,
} = require("../controllers/templateController");
const { uploadTemplateMedia } = require("../controllers/templateMediaController");
const multer = require("multer");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const templateSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).required(),
  language: Joi.string().min(2).max(20).required(),
  category: Joi.string().valid("marketing", "utility", "authentication").required(),
  components: Joi.array().items(Joi.object().unknown(true)).min(1).required(),
  status: Joi.forbidden(),
  metaTemplateId: Joi.forbidden(),
});

router.post("/media", auth, requireWorkspace, upload.single("file"), asyncHandler(uploadTemplateMedia));
router.post("/", auth, requireWorkspace, validate(templateSchema), asyncHandler(createTemplate));
router.get("/", auth, requireWorkspace, asyncHandler(listTemplates));
router.post(
  "/sync-meta",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
    })
  ),
  asyncHandler(syncMetaTemplates)
);
router.get("/:id", auth, requireWorkspace, asyncHandler(getTemplate));

router.put(
  "/:id",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
      language: Joi.string().min(2).max(20).optional(),
      category: Joi.string().valid("marketing", "utility", "authentication").optional(),
      components: Joi.array().items(Joi.object().unknown(true)).min(1).optional(),
    })
  ),
  asyncHandler(updateTemplate)
);

router.delete("/:id", auth, requireWorkspace, asyncHandler(deleteTemplate));
router.post("/:id/submit", auth, requireWorkspace, asyncHandler(submitForApproval));
router.get("/:id/status", auth, requireWorkspace, asyncHandler(syncStatus));

module.exports = router;
