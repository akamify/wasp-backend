const { CrmLead } = require("@infra/database/CrmLead");

async function upsertLeadOnInbound({ workspaceId, phone, inboundAt }) {
  const now = inboundAt || new Date();
  return CrmLead.findOneAndUpdate(
    { workspaceId, phone },
    {
      $set: { lastInboundAt: now, lastActivityAt: now },
      $setOnInsert: { firstInboundAt: now, status: "OPEN" },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

async function setAssignment({ workspaceId, phone, employeeId, assignedAt }) {
  return CrmLead.findOneAndUpdate(
    { workspaceId, phone },
    { $set: { assignedEmployeeId: employeeId, assignedAt: assignedAt || new Date(), status: "OPEN" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

module.exports = {
  upsertLeadOnInbound,
  setAssignment,
};

