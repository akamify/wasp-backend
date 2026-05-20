const { Workspace } = require("@infra/database/Workspace");
const { Conversation } = require("@infra/database/Conversation");
const leadRepo = require("@modules/crm/repositories/lead.repository");
const { pickRoundRobinEmployee } = require("@modules/crm/services/leadDistribution.service");
const { assignConversation } = require("@modules/crm/services/leadAssignment.service");

async function detectAndAssignLead({ workspaceId, phone, inboundAt }) {
  const workspace = await Workspace.findOne({ _id: workspaceId, isActive: true }).select("_id crmEnabled crmSettings");
  if (!workspace || !workspace.crmEnabled) return { ok: true, skipped: "crm_disabled" };

  const windowHours = Number(workspace.crmSettings?.leadWindowHours || 48);
  const windowMs = Math.max(1, windowHours) * 60 * 60 * 1000;

  const conversation = await Conversation.findOne({ workspaceId, phone }).select("_id assignedEmployeeId lastInboundAt");
  if (!conversation) return { ok: true, skipped: "no_conversation" };

  const now = inboundAt ? new Date(inboundAt) : new Date();
  await leadRepo.upsertLeadOnInbound({ workspaceId, phone, inboundAt: now });

  const lastInboundAt = conversation.lastInboundAt ? new Date(conversation.lastInboundAt) : null;
  const withinWindow = lastInboundAt ? now.getTime() - lastInboundAt.getTime() <= windowMs : false;

  if (conversation.assignedEmployeeId && withinWindow) {
    return { ok: true, skipped: "already_assigned_active" };
  }

  const employeeId = await pickRoundRobinEmployee({ workspaceId });
  if (!employeeId) return { ok: true, skipped: "no_employees" };

  const assigned = await assignConversation({
    workspaceId,
    phone,
    toEmployeeId: employeeId,
    mode: "ROUND_ROBIN",
    reason: "inbound_lead",
    assignedBy: { kind: "system" },
  });

  return { ok: true, assigned };
}

module.exports = { detectAndAssignLead };

