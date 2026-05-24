const { Employee } = require("@infra/database/Employee");

function findByEmail({ workspaceId, email, select = "" }) {
  return Employee.findOne({ workspaceId, email: String(email || "").trim().toLowerCase() }).select(select);
}

function findById({ workspaceId, employeeId, select = "" }) {
  return Employee.findOne({ _id: employeeId, workspaceId }).select(select);
}

async function setPasswordResetToken({ workspaceId, employeeId, tokenHash, expiresAt }) {
  await Employee.updateOne(
    { _id: employeeId, workspaceId },
    { $set: { passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: expiresAt } }
  );
}

async function updatePasswordByResetToken({ tokenHash, newPasswordHash }) {
  const employee = await Employee.findOne({ passwordResetTokenHash: tokenHash })
    .select("+passwordResetTokenHash +passwordResetTokenExpiresAt +passwordHash workspaceId email name status deletedAt");
  if (!employee) return null;
  return employee;
}

module.exports = {
  findByEmail,
  findById,
  setPasswordResetToken,
  updatePasswordByResetToken,
};
