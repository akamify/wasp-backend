const Joi = require("joi");
const { HttpError } = require("@shared/utils/httpError");
const { Conversation } = require("@infra/database/Conversation");
const { Employee } = require("@infra/database/Employee");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { writeConversationEvent } = require("@modules/crm/services/conversationEvent.service");
const { assignConversation } = require("@modules/crm/services/leadAssignment.service");
const { normalizePhone } = require("@shared/services/contactService");

const assignSchema = Joi.object({
  employeeId: Joi.string().required().allow(""),
  reason: Joi.string().allow("").max(200).optional(),
});

async function manualAssign(req, res) {
  const payload = await assignSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const conversation = await Conversation.findOne({ workspaceId: req.workspace.id, phone }).select(
    "_id assignedEmployeeId assignmentVersion"
  );
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const employeeId = String(payload.employeeId || "").trim();
  if (!employeeId) throw new HttpError(400, "employeeId is required");

  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id, status: "ACTIVE", deletedAt: null }).select("_id name email");
  if (!employee) throw new HttpError(404, "Employee not found");

  const assigned = await assignConversation({
    workspaceId: req.workspace.id,
    phone,
    toEmployeeId: employeeId,
    mode: "MANUAL",
    reason: payload.reason || "manual_assign",
    assignedBy: { kind: "owner", actorId: req.user.id },
  });

  if (!assigned || assigned.assigned !== true) {
    const r = String(assigned?.reason || "");
    if (r === "assignment_conflict") throw new HttpError(409, "Assignment changed. Refresh and try again.");
    if (r === "crm_disabled") throw new HttpError(403, "CRM is disabled for this workspace");
    if (r === "no_employee") throw new HttpError(404, "Employee not found");
    if (r === "no_conversation") throw new HttpError(404, "Conversation not found");
    throw new HttpError(400, "Failed to assign lead");
  }

  await writeAuditLog(req, {
    action: "crm.lead.assign.manual",
    resourceType: "conversation",
    resourceId: String(conversation._id),
    metadata: { phone, toEmployeeId: employeeId, reason: payload.reason || "" },
  });

  await writeConversationEvent({
    workspaceId: req.workspace.id,
    conversationId: conversation._id,
    phone,
    type: "reassigned",
    actor: { kind: "owner", actorId: req.user.id, nameSnapshot: null },
    payload: { fromEmployeeId: assigned?.fromEmployeeId || null, toEmployeeId: employeeId, mode: "MANUAL", reason: payload.reason || "" },
  }).catch(() => {});

  res.json({ success: true, assigned });
}

module.exports = {
  manualAssign,
};
