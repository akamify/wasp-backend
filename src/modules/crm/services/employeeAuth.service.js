const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { jwtSecret, jwtExpiresIn, appBaseUrl } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { sendEmail } = require("@shared/services/emailService");
const { sha256Hex } = require("@shared/utils/hash");
const employeeRepo = require("@modules/crm/repositories/employee.repository");

function signEmployeeToken({ employee, workspaceId }) {
  return jwt.sign(
    {
      sub: String(employee._id),
      workspaceId: String(workspaceId),
      typ: "crm_employee",
      sessionVersion: Number(employee.sessionVersion || 0),
    },
    jwtSecret,
    { expiresIn: jwtExpiresIn }
  );
}

function assertActiveEmployee(employee) {
  if (!employee) throw new HttpError(401, "Invalid credentials");
  if (employee.deletedAt) throw new HttpError(403, "Employee account is inactive");
  const status = String(employee.status || "ACTIVE").toUpperCase();
  if (status === "DELETED" || status === "DISABLED") throw new HttpError(403, "Employee account is inactive");
  if (status === "BLOCKED") throw new HttpError(403, "Employee account is blocked");
}

async function loginEmployee({ workspaceId, email, password }) {
  const employee = await employeeRepo.findByEmail({
    workspaceId,
    email,
    select: "+passwordHash workspaceId email name role status permissions sessionVersion deletedAt",
  });
  assertActiveEmployee(employee);

  const ok = await bcrypt.compare(String(password || ""), employee.passwordHash);
  if (!ok) throw new HttpError(401, "Invalid credentials");

  employee.lastLoginAt = new Date();
  await employee.save();

  return {
    token: signEmployeeToken({ employee, workspaceId }),
    employee: {
      id: String(employee._id),
      workspaceId: String(workspaceId),
      email: employee.email,
      name: employee.name || "",
      role: employee.role || "agent",
      permissions: employee.permissions || {},
      lastLoginAt: employee.lastLoginAt || null,
    },
  };
}

async function forgotEmployeePassword({ workspaceId, email }) {
  const employee = await employeeRepo.findByEmail({
    workspaceId,
    email,
    select: "_id workspaceId email name status deletedAt +passwordResetTokenHash +passwordResetTokenExpiresAt",
  });
  // Always respond success to avoid email enumeration.
  if (!employee) return { success: true };

  try {
    assertActiveEmployee(employee);
  } catch {
    return { success: true };
  }

  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await employeeRepo.setPasswordResetToken({ workspaceId, employeeId: employee._id, tokenHash, expiresAt });

  const resetLink = `${String(appBaseUrl || "").replace(/\/+$/, "")}/employee/reset-password?token=${encodeURIComponent(
    rawToken
  )}`;

  await sendEmail({
    toEmail: employee.email,
    toName: employee.name || "",
    subject: "Reset your CRM employee password",
    htmlContent: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h2 style="margin:0 0 12px">Password Reset</h2>
        <p>Click the link below to reset your CRM employee password.</p>
        <p><a href="${resetLink}">Reset Password</a></p>
        <p style="font-size:12px;color:#64748b">This link expires in 30 minutes.</p>
      </div>
    `,
    textContent: `Reset your CRM employee password: ${resetLink}`,
  }).catch(() => {});

  return { success: true };
}

async function resetEmployeePassword({ token, newPassword }) {
  const raw = String(token || "").trim();
  if (!raw) throw new HttpError(400, "Missing token");
  const tokenHash = sha256Hex(raw);

  const employee = await employeeRepo.updatePasswordByResetToken({ tokenHash });
  if (!employee) throw new HttpError(400, "Invalid or expired token");
  assertActiveEmployee(employee);

  if (!employee.passwordResetTokenExpiresAt || employee.passwordResetTokenExpiresAt < new Date()) {
    throw new HttpError(400, "Invalid or expired token");
  }

  const hash = await bcrypt.hash(String(newPassword || ""), 10);
  employee.passwordHash = hash;
  employee.passwordResetTokenHash = undefined;
  employee.passwordResetTokenExpiresAt = undefined;
  employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
  await employee.save();

  return { success: true };
}

module.exports = {
  loginEmployee,
  forgotEmployeePassword,
  resetEmployeePassword,
};

