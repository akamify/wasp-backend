const { Conversation } = require("@infra/database/Conversation");
const { HttpError } = require("@shared/utils/httpError");
const { normalizePhone } = require("@shared/services/contactService");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

function requireConversationAccess(mode) {
  return async (req, res, next) => {
    try {
      const workspaceId = String(req.workspace?.id || "").trim();
      const employeeId = String(req.employee?.id || "").trim();
      const phone = normalizePhone(req.params.phone);
      if (!workspaceId) return next(new HttpError(400, "Missing workspaceId"));
      if (!employeeId) return next(new HttpError(401, "Unauthorized"));
      if (!phone) return next(new HttpError(400, "Invalid phone number"));

      const scope = await requireActiveWabaScope(workspaceId);
      const conversation = await Conversation.findOne({ workspaceId, wabaId: scope.wabaId, phone }).select(
        "_id workspaceId phone assignedEmployeeId assignmentLockedUntil"
      );
      if (!conversation) return next(new HttpError(404, "Conversation not found"));

      const assignedId = conversation.assignedEmployeeId ? String(conversation.assignedEmployeeId) : "";
      if (!assignedId || assignedId !== employeeId) {
        if (mode === "reply" || mode === "media_upload") {
          const lockUntil = conversation.assignmentLockedUntil ? new Date(conversation.assignmentLockedUntil) : null;
          if (lockUntil && lockUntil > new Date()) {
            return next(new HttpError(409, "Conversation assignment changed. Refresh required."));
          }
          return next(new HttpError(403, "Forbidden"));
        }
        return next(new HttpError(403, "Forbidden"));
      }

      // Lock only blocks non-current assignees; current assignee always allowed.
      // Since we've already validated current assignee match, the lock does not block here.
      // (The lock is still present on Conversation for later enforcement in transfer/reassign flows.)
      if (mode === "reply" || mode === "media_upload") {
        // Keep for forward compatibility: if future logic allows acting as "previous assignee",
        // respond 409 during lock window.
        const lockUntil = conversation.assignmentLockedUntil ? new Date(conversation.assignmentLockedUntil) : null;
        if (lockUntil && lockUntil > new Date()) {
          // Current assignee is allowed; no-op.
        }
      }

      req.crmConversation = {
        id: String(conversation._id),
        phone,
        assignedEmployeeId: assignedId,
        assignmentLockedUntil: conversation.assignmentLockedUntil || null,
      };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireConversationAccess };
