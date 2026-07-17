const { CrmAssignmentAudit } = require("@infra/database/CrmAssignmentAudit");
const { Employee } = require("@infra/database/Employee");

async function writeAssignmentAudit({ workspaceId, phone, fromEmployeeId, toEmployeeId, mode, reason, assignedBy }) {
  return CrmAssignmentAudit.create({
    workspaceId,
    phone,
    fromEmployeeId: fromEmployeeId || null,
    toEmployeeId: toEmployeeId || null,
    mode: mode || "",
    reason: reason || "",
    assignedBy: assignedBy || null,
  });
}

async function incrementAssignedChatsCount({ workspaceId, employeeId, delta }) {
  if (!employeeId || !delta) return;
  const filter = { _id: employeeId, workspaceId };
  if (Number(delta) < 0) filter.assignedChatsCount = { $gt: 0 };
  await Employee.updateOne(filter, { $inc: { assignedChatsCount: delta } });
}

module.exports = {
  writeAssignmentAudit,
  incrementAssignedChatsCount,
};

