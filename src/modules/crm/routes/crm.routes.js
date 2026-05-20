const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { employeeAuth } = require("@modules/crm/middleware/employeeAuth");
const { requireEmployeeWorkspace } = require("@modules/crm/middleware/requireEmployeeWorkspace");
const { requireCrmFeature } = require("@modules/crm/middleware/requireCrmFeature");
const { requireCrmWorkspaceFromBody } = require("@modules/crm/middleware/requireCrmWorkspaceFromBody");
const employeeAuthController = require("@modules/crm/controllers/employeeAuth.controller");
const employeeConversationsController = require("@modules/crm/controllers/employeeConversations.controller");
const employeeMessagesController = require("@modules/crm/controllers/employeeMessages.controller");
const { requireConversationAccess } = require("@modules/crm/middleware/requireConversationAccess");
const { bindPhoneParamFromBody } = require("@modules/crm/middleware/bindPhoneParamFromBody");
const { validate } = require("@core/middleware/validate");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { uploadMessageMedia, downloadMessageMedia } = require("@modules/messages/controllers/messageMedia.controller");
const { messagesByPhone } = require("@modules/messages/controllers/message.controller");
const { streamEmployeeRealtime } = require("@modules/crm/controllers/employeeRealtime.controller");
const {
  listOwnerConversationEvents,
  listEmployeeConversationEvents,
} = require("@modules/crm/controllers/conversationEvents.controller");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/aac",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
});

// Employee auth
router.post("/employee/login", requireCrmWorkspaceFromBody, employeeAuthController.login);
router.post("/employee/forgot-password", requireCrmWorkspaceFromBody, employeeAuthController.forgotPassword);
router.post("/employee/reset-password", employeeAuthController.resetPassword);

// Owner/admin timeline
router.get(
  "/conversations/:phone/events",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(listOwnerConversationEvents)
);

// Employee timeline (requires employee JWT)
router.get(
  "/employee/conversations/:phone/events",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(listEmployeeConversationEvents)
);

// Employee inbox
router.get(
  "/employee/conversations",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeConversationsController.listEmployeeConversations)
);
router.get(
  "/employee/conversations/:phone",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeConversationsController.getEmployeeConversation)
);
router.post(
  "/employee/conversations/:phone/read",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeConversationsController.readEmployeeConversation)
);

// Employee messages: reuse the exact message list response for UI parity
router.get(
  "/employee/messages/:phone",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  requireConversationAccess("view"),
  asyncHandler(messagesByPhone)
);
router.post(
  "/employee/messages/send-text",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  validate(employeeMessagesController.sendTextSchema),
  bindPhoneParamFromBody("to"),
  requireConversationAccess("reply"),
  asyncHandler(employeeMessagesController.sendText)
);
router.post(
  "/employee/messages/send-media",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  validate(employeeMessagesController.sendMediaSchema),
  bindPhoneParamFromBody("to"),
  requireConversationAccess("reply"),
  asyncHandler(employeeMessagesController.sendMedia)
);
router.post(
  "/employee/messages/media",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  upload.single("file"),
  asyncHandler(uploadMessageMedia)
);
router.get(
  "/employee/messages/media/:id",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(downloadMessageMedia)
);

router.get(
  "/employee/realtime/stream",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(streamEmployeeRealtime)
);

module.exports = router;
