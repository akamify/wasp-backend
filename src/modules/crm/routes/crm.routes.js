const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { employeeAuth } = require("@modules/crm/middleware/employeeAuth");
const { employeeAuthSse } = require("@modules/crm/middleware/employeeAuthSse");
const { requireEmployeeWorkspace } = require("@modules/crm/middleware/requireEmployeeWorkspace");
const { requireCrmFeature } = require("@modules/crm/middleware/requireCrmFeature");
const { requireCrmWorkspaceFromBody } = require("@modules/crm/middleware/requireCrmWorkspaceFromBody");
const employeeAuthController = require("@modules/crm/controllers/employeeAuth.controller");
const employeeConversationsController = require("@modules/crm/controllers/employeeConversations.controller");
const employeeMessagesController = require("@modules/crm/controllers/employeeMessages.controller");
const employeeLeadsController = require("@modules/crm/controllers/employeeLeads.controller");
const { requireConversationAccess } = require("@modules/crm/middleware/requireConversationAccess");
const { bindPhoneParamFromBody } = require("@modules/crm/middleware/bindPhoneParamFromBody");
const { validate } = require("@core/middleware/validate");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { uploadMessageMedia, downloadMessageMedia } = require("@modules/messages/controllers/messageMedia.controller");
const { messagesByPhone, messageStatusByWaId } = require("@modules/messages/controllers/message.controller");
const { streamEmployeeRealtime } = require("@modules/crm/controllers/employeeRealtime.controller");
const {
  listOwnerConversationEvents,
  listEmployeeConversationEvents,
} = require("@modules/crm/controllers/conversationEvents.controller");
const crmOwnerController = require("@modules/crm/controllers/crmOwner.controller");
const crmLeadsController = require("@modules/crm/controllers/crmLeads.controller");
const crmDashboardController = require("@modules/crm/controllers/crmDashboard.controller");
const employeeOwnerProfileController = require("@modules/crm/controllers/employeeOwnerProfile.controller");
const employeeProfileRequestsController = require("@modules/crm/controllers/employeeProfileRequests.controller");

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
router.post("/employee/reset-password", employeeAuthController.resetPassword);
router.post(
  "/employee/logout",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeAuthController.logout)
);

// Owner/admin timeline
router.get(
  "/conversations/:phone/events",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(listOwnerConversationEvents)
);

// Owner CRM management
router.get("/workspace", auth, requireWorkspace, asyncHandler(crmOwnerController.getWorkspaceCrm));
router.get(
  "/dashboard",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmDashboardController.getDashboard)
);
router.put(
  "/settings/lead-window",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.setLeadWindowHours)
);
router.put(
  "/settings/assignment-lock",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.setAssignmentLockMinutes)
);
router.put(
  "/settings/assignment-mode",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.setAssignmentMode)
);
router.put(
  "/settings/assignment-schedule",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.setAssignmentSchedule)
);
router.get(
  "/employees",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.listEmployees)
);
router.post(
  "/employees",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.createEmployee)
);
router.patch(
  "/employees/:employeeId/status",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmOwnerController.updateEmployeeStatus)
);
router.post(
  "/leads/:phone/assign",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(crmLeadsController.manualAssign)
);
router.get(
  "/employees/:employeeId/profile",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.getEmployeeProfile)
);
router.patch(
  "/employees/:employeeId/profile",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.updateEmployeeProfile)
);
router.post(
  "/employees/:employeeId/send-reset-link",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.sendEmployeePasswordResetLink)
);
router.post(
  "/employees/:employeeId/reset-password",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.setEmployeePasswordDirect)
);
router.get(
  "/employees/:employeeId/leads",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.listEmployeeLeads)
);
router.get(
  "/employees/:employeeId/activities",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.listEmployeeActivities)
);
router.get(
  "/employees/:employeeId/sessions",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeOwnerProfileController.listEmployeeSessions)
);
router.post(
  "/employees/:employeeId/verify-email-otp",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeProfileRequestsController.verifyOwnerEmployeeEmailOtp)
);

// Owner: employee requests
router.get(
  "/employee-requests",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeProfileRequestsController.listOwnerRequests)
);
router.post(
  "/employee-requests/:requestId/decide",
  auth,
  requireWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeProfileRequestsController.decideOwnerRequest)
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
  "/employee/leads",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeLeadsController.listEmployeeLeads)
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
router.get(
  "/employee/messages/status/:waId",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(messageStatusByWaId)
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
  employeeAuthSse,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(streamEmployeeRealtime)
);

// Employee: profile requests (employee cannot send password reset links)
router.get(
  "/employee/profile-requests",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeProfileRequestsController.listEmployeeRequests)
);
router.post(
  "/employee/profile-requests",
  employeeAuth,
  requireEmployeeWorkspace,
  requireCrmFeature("crm"),
  asyncHandler(employeeProfileRequestsController.submitEmployeeRequest)
);

module.exports = router;
