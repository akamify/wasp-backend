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
  await Employee.updateOne({ _id: employeeId, workspaceId }, { $inc: { assignedChatsCount: delta } });
}

module.exports = {
  writeAssignmentAudit,
  incrementAssignedChatsCount,
};

