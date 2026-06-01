const { Workspace } = require("@infra/database/Workspace");
const { Conversation } = require("@infra/database/Conversation");
const { getCrmLeadAssignmentQueue } = require("@infra/queues/crmLeadAssignment.queue");
const leadRepo = require("@modules/crm/repositories/lead.repository");
const { pickEmployeeByMode } = require("@modules/crm/services/leadDistribution.service");
const { assignConversation } = require("@modules/crm/services/leadAssignment.service");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

function parseHHMM(value) {
  const s = String(value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(":").map((n) => Number(n));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function isWithinScheduleWindow({ now, fromTime, toTime }) {
  const from = parseHHMM(fromTime);
  const to = parseHHMM(toTime);
  if (from === null || to === null) return true;
  if (from === to) return true; // treat as 24h window

  const mins = now.getHours() * 60 + now.getMinutes();
  // Normal same-day window (e.g. 09:00 -> 18:00)
  if (from < to) return mins >= from && mins < to;
  // Overnight window (e.g. 22:00 -> 06:00)
  return mins >= from || mins < to;
}

function nextFromTimeDate({ now, fromTime }) {
  const from = parseHHMM(fromTime);
  if (from === null) return null;
  const next = new Date(now);
  next.setSeconds(0, 0);
  const hh = Math.floor(from / 60);
  const mm = from % 60;
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(hh, mm, 0, 0);
  }
  return next;
}

async function detectAndAssignLead({ workspaceId, wabaId, phone, inboundAt }) {
  const workspace = await Workspace.findOne({ _id: workspaceId, isActive: true }).select("_id crmEnabled crmSettings");
  if (!workspace || !workspace.crmEnabled) return { ok: true, skipped: "crm_disabled" };

  const windowHours = Number(workspace.crmSettings?.leadWindowHours || 22);
  const windowMs = Math.max(1, windowHours) * 60 * 60 * 1000;

  const scope = wabaId ? { wabaId: String(wabaId) } : await requireActiveWabaScope(workspaceId);
  const conversation = await Conversation.findOne({ workspaceId, wabaId: scope.wabaId, phone }).select(
    "_id assignedEmployeeId lastInboundAt lastLeadCreatedAt leadStatus"
  );
  if (!conversation) return { ok: true, skipped: "no_conversation" };

  const now = inboundAt ? new Date(inboundAt) : new Date();
  await leadRepo.upsertLeadOnInbound({ workspaceId, phone, inboundAt: now });

  const lastLeadCreatedAt = conversation.lastLeadCreatedAt ? new Date(conversation.lastLeadCreatedAt) : null;
  const withinLeadWindow = lastLeadCreatedAt ? now.getTime() - lastLeadCreatedAt.getTime() <= windowMs : false;

  if (conversation.assignedEmployeeId && withinLeadWindow) {
    return { ok: true, skipped: "already_assigned_active" };
  }

  // Ensure conversation is marked as an active lead on fresh/expired windows (even if assignment cannot happen).
  if (!withinLeadWindow) {
    await Conversation.updateOne(
      { _id: conversation._id, workspaceId },
      {
        $set: {
          leadStatus: "OPEN",
          leadStatusUpdatedAt: now,
          leadStatusUpdatedBy: { kind: "system" },
          lastLeadCreatedAt: now,
        },
      }
    ).catch(() => {});
  }

  const mode = String(workspace.crmSettings?.assignmentMode || "ROUND_ROBIN").toUpperCase();
  const autoAssignEnabled = workspace.crmSettings?.autoAssignEnabled !== false;
  const effectiveMode = autoAssignEnabled && mode === "MANUAL" ? "ROUND_ROBIN" : mode;

  // If auto assignment is disabled (or mode is MANUAL), we still treat this as a lead (OPEN)
  // but do not assign automatically.
  if (!autoAssignEnabled || effectiveMode === "MANUAL") {
    await Conversation.updateOne(
      { _id: conversation._id, workspaceId },
      {
        $set: {
          leadStatus: "OPEN",
          leadStatusUpdatedAt: now,
          leadStatusUpdatedBy: { kind: "system" },
          lastLeadCreatedAt: now,
        },
      }
    ).catch(() => {});
    return { ok: true, skipped: "auto_assign_disabled" };
  }

  const withinSchedule = isWithinScheduleWindow({
    now,
    fromTime: workspace.crmSettings?.autoAssignFromTime,
    toTime: workspace.crmSettings?.autoAssignToTime,
  });
  if (!withinSchedule) {
    // Store lead now, but schedule an assignment attempt at the next "from" time.
    const nextFrom = nextFromTimeDate({ now, fromTime: workspace.crmSettings?.autoAssignFromTime });
    if (nextFrom) {
      const delayMs = Math.max(1, nextFrom.getTime() - now.getTime());
      const queue = getCrmLeadAssignmentQueue();
      const jobId = `crm:autoAssignAt:${String(workspaceId)}:${String(phone)}:${nextFrom.toISOString().slice(0, 16)}`;
      await queue
        .add(
          "crm.lead.detect_and_assign",
          // IMPORTANT: do not pass inboundAt here. The delayed job must evaluate schedule
          // using the execution time (not the original inbound message time),
          // otherwise it can get stuck in an infinite outside_schedule loop.
          { workspaceId, wabaId: scope.wabaId, phone },
          { jobId, delay: delayMs }
        )
        .catch(() => {});
      return { ok: true, skipped: "outside_schedule_scheduled", scheduledAt: nextFrom.toISOString() };
    }
    return { ok: true, skipped: "outside_schedule" };
  }

  const employeeId = await pickEmployeeByMode({ workspaceId, mode: effectiveMode });
  if (!employeeId) return { ok: true, skipped: "no_eligible_employee" };

  const assigned = await assignConversation({
    workspaceId,
    wabaId: scope.wabaId,
    phone,
    toEmployeeId: employeeId,
    mode: effectiveMode,
    reason: "inbound_lead",
    assignedBy: { kind: "system" },
  });

  return { ok: true, assigned };
}

module.exports = { detectAndAssignLead };
