const mongoose = require("mongoose");
const { Conversation } = require("@infra/database/Conversation");
const { Workspace } = require("@infra/database/Workspace");
const { Employee } = require("@infra/database/Employee");
const { publishWorkspaceEvent } = require("@shared/services/realtimeService");
const { createRedisConnection } = require("@infra/redis/redisClient");
const { writeConversationEvent } = require("@modules/crm/services/conversationEvent.service");
const leadRepo = require("@modules/crm/repositories/lead.repository");
const assignmentRepo = require("@modules/crm/repositories/assignment.repository");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

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
  wabaId,
  phone,
  toEmployeeId,
  mode,
  reason,
  assignedBy,
}) {
  const workspace = await Workspace.findById(workspaceId).select("_id crmEnabled crmSettings isActive");
  if (!workspace || !workspace.isActive || !workspace.crmEnabled) return { assigned: false, reason: "crm_disabled" };
  const scope = wabaId ? { wabaId: String(wabaId) } : await requireActiveWabaScope(workspaceId);

  const now = new Date();
  const lockMinutes = Number(workspace.crmSettings?.assignmentLockMinutes || 5);
  const safeLockMinutes = Math.max(0, Number.isFinite(lockMinutes) ? lockMinutes : 0);
  const lockedUntil = safeLockMinutes > 0 ? new Date(Date.now() + safeLockMinutes * 60 * 1000) : null;

  const employee = await Employee.findOne({ _id: toEmployeeId, workspaceId, status: "ACTIVE", deletedAt: null }).select("_id");
  if (!employee) return { assigned: false, reason: "no_employee" };

  // Optimistic locking on assignmentVersion.
  let conversation = await Conversation.findOne({ workspaceId, wabaId: scope.wabaId, phone }).select(
    "_id assignedEmployeeId assignmentVersion lastInboundAt"
  );
  if (!conversation) return { assigned: false, reason: "no_conversation" };

  const fromEmployeeId = conversation.assignedEmployeeId ? String(conversation.assignedEmployeeId) : null;
  const rawVersion = conversation.assignmentVersion;
  const hasVersion = typeof rawVersion === "number" && Number.isFinite(rawVersion);
  const currentVersion = hasVersion ? rawVersion : 0;

  // Backward compatibility: older Conversation documents might not have assignmentVersion.
  // When missing, treat it as 0 for optimistic locking match.
  const versionMatch = hasVersion
    ? { assignmentVersion: currentVersion }
    : {
        $or: [
          { assignmentVersion: currentVersion },
          { assignmentVersion: String(currentVersion) },
          { assignmentVersion: null },
          { assignmentVersion: { $exists: false } },
        ],
      };

  const result = await Conversation.updateOne(
    { _id: conversation._id, workspaceId, ...versionMatch },
    {
      $set: {
        assignedEmployeeId: toObjectId(toEmployeeId),
        assignedAt: now,
        assignedBy: assignedBy || { kind: "system" },
        assignmentMode: mode || "ROUND_ROBIN",
        assignmentReason: reason || "",
        assignmentLockedUntil: lockedUntil,
        assignmentVersion: currentVersion + 1,
        leadStatus: "OPEN",
        leadStatusUpdatedAt: now,
        leadStatusUpdatedBy: assignedBy || { kind: "system" },
        lastLeadCreatedAt: now,
        normalizedPhone: String(phone),
      },
    }
  );

  if (Number(result?.matchedCount || 0) === 0) {
    // Conflict means someone else updated assignmentVersion.
    // If the desired assignee is already set, treat as idempotent success.
    const latest = await Conversation.findOne({ _id: conversation._id, workspaceId }).select("_id assignedEmployeeId").lean();
    const latestAssignedId = latest?.assignedEmployeeId ? String(latest.assignedEmployeeId) : "";
    if (latestAssignedId && latestAssignedId === String(toEmployeeId)) {
      return {
        assigned: true,
        conversationId: String(conversation._id),
        fromEmployeeId,
        toEmployeeId: String(toEmployeeId),
        idempotent: true,
      };
    }
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
