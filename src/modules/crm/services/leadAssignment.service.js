const mongoose = require("mongoose");
const { Conversation } = require("@infra/database/Conversation");
const { Workspace } = require("@infra/database/Workspace");
const { Employee } = require("@infra/database/Employee");
const { publishWorkspaceEvent } = require("@shared/services/realtimeService");
const { createRedisConnection } = require("@infra/redis/redisClient");
const { writeConversationEvent } = require("@modules/crm/services/conversationEvent.service");
const leadRepo = require("@modules/crm/repositories/lead.repository");
const assignmentRepo = require("@modules/crm/repositories/assignment.repository");

function toObjectId(value) {
  if (!value) return null;
  const s = String(value);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

async function setEmployeePhoneMembership({ employeeId, phone, add }) {
  if (!employeeId || !phone) return;
  const redis = createRedisConnection();
  const key = `crm:employee:${String(employeeId)}:assignedPhones`;
  if (add) await redis.sadd(key, String(phone));
  else await redis.srem(key, String(phone));
}

async function assignConversation({
  workspaceId,
  phone,
  toEmployeeId,
  mode,
  reason,
  assignedBy,
}) {
  const workspace = await Workspace.findById(workspaceId).select("_id crmEnabled crmSettings isActive");
  if (!workspace || !workspace.isActive || !workspace.crmEnabled) return { assigned: false, reason: "crm_disabled" };

  const now = new Date();
  const lockMinutes = Number(workspace.crmSettings?.assignmentLockMinutes || 5);
  const lockedUntil = new Date(Date.now() + Math.max(1, lockMinutes) * 60 * 1000);

  const employee = await Employee.findOne({ _id: toEmployeeId, workspaceId, status: "ACTIVE", deletedAt: null }).select("_id");
  if (!employee) return { assigned: false, reason: "no_employee" };

  // Optimistic locking on assignmentVersion.
  let conversation = await Conversation.findOne({ workspaceId, phone }).select(
    "_id assignedEmployeeId assignmentVersion lastInboundAt"
  );
  if (!conversation) return { assigned: false, reason: "no_conversation" };

  const fromEmployeeId = conversation.assignedEmployeeId ? String(conversation.assignedEmployeeId) : null;
  const currentVersion = Number(conversation.assignmentVersion || 0);

  const result = await Conversation.updateOne(
    { _id: conversation._id, workspaceId, assignmentVersion: currentVersion },
    {
      $set: {
        assignedEmployeeId: toObjectId(toEmployeeId),
        assignedAt: now,
        assignedBy: assignedBy || { kind: "system" },
        assignmentMode: mode || "ROUND_ROBIN",
        assignmentReason: reason || "",
        assignmentLockedUntil: lockedUntil,
        leadStatus: "OPEN",
        leadStatusUpdatedAt: now,
        leadStatusUpdatedBy: assignedBy || { kind: "system" },
        lastLeadCreatedAt: now,
        normalizedPhone: String(phone),
      },
      $inc: { assignmentVersion: 1 },
    }
  );

  if (Number(result?.matchedCount || 0) === 0) {
    return { assigned: false, reason: "assignment_conflict" };
  }

  await leadRepo.setAssignment({ workspaceId, phone, employeeId: toEmployeeId, assignedAt: now });
  await assignmentRepo.writeAssignmentAudit({
    workspaceId,
    phone,
    fromEmployeeId,
    toEmployeeId,
    mode,
    reason,
    assignedBy: assignedBy || { kind: "system" },
  });

  // Redis allowlist sets
  await setEmployeePhoneMembership({ employeeId: toEmployeeId, phone, add: true });
  if (fromEmployeeId && fromEmployeeId !== String(toEmployeeId)) {
    await setEmployeePhoneMembership({ employeeId: fromEmployeeId, phone, add: false });
  }

  // Business timeline
  await writeConversationEvent({
    workspaceId,
    conversationId: conversation._id,
    phone,
    type: fromEmployeeId ? "reassigned" : "assigned",
    actor: { kind: String(assignedBy?.kind || "system"), actorId: assignedBy?.actorId || undefined },
    payload: { fromEmployeeId, toEmployeeId, mode: mode || "ROUND_ROBIN", reason: reason || "" },
  }).catch(() => {});

  publishWorkspaceEvent(workspaceId, { type: "assignment_changed", phone, assignedEmployeeId: String(toEmployeeId) });

  return { assigned: true, conversationId: String(conversation._id), fromEmployeeId, toEmployeeId: String(toEmployeeId) };
}

module.exports = {
  assignConversation,
};

