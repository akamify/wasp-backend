const Joi = require("joi");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { appBaseUrl } = require("@core/config/env");
const { Employee } = require("@infra/database/Employee");
const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { HttpError } = require("@shared/utils/httpError");
const { sendEmail } = require("@shared/services/emailService");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { sha256Hex } = require("@shared/utils/hash");
const employeeRepo = require("@modules/crm/repositories/employee.repository");

function randomPassword() {
  return crypto.randomBytes(18).toString("base64url").slice(0, 12);
}

async function requireActiveCrmWorkspaceForOwner({ workspaceId, ownerId }) {
  const workspace = await Workspace.findOne({ _id: workspaceId, ownerId, isActive: true }).select(
    "_id ownerId name plan isActive crmEnabled crmSettings"
  );
  if (!workspace) throw new HttpError(404, "Workspace not found");
  return workspace;
}

const leadWindowSchema = Joi.object({
  leadWindowHours: Joi.number().integer().min(1).max(720).required(),
});

const assignmentLockSchema = Joi.object({
  assignmentLockMinutes: Joi.number().integer().min(1).max(120).required(),
});

const createEmployeeSchema = Joi.object({
  email: Joi.string().email().required(),
  name: Joi.string().allow("").max(100).optional(),
  role: Joi.string().valid("employee", "team_leader").allow("").optional(),
  permissions: Joi.object().unknown(true).optional(),
});

const updateEmployeeStatusSchema = Joi.object({
  status: Joi.string().valid("ACTIVE", "BLOCKED", "DISABLED", "DELETED").required(),
});

async function getWorkspaceCrm(req, res) {
  const workspace = await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeesCount = await Employee.countDocuments({
    workspaceId: req.workspace.id,
    status: { $ne: "DELETED" },
  });
  res.json({
    success: true,
    workspace: {
      id: String(workspace._id),
      name: workspace.name,
      plan: workspace.plan,
      crmEnabled: Boolean(workspace.crmEnabled),
      crmSettings: workspace.crmSettings || {},
      employeesCount,
    },
  });
}

async function setLeadWindowHours(req, res) {
  const payload = await leadWindowSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspace = await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  workspace.crmSettings = workspace.crmSettings || {};
  workspace.crmSettings.leadWindowHours = Number(payload.leadWindowHours);
  await workspace.save();

  await writeAuditLog(req, {
    action: "crm.workspace.settings.leadWindowHours",
    resourceType: "workspace",
    resourceId: String(workspace._id),
    metadata: { leadWindowHours: workspace.crmSettings.leadWindowHours },
  });

  res.json({ success: true, workspace: { id: String(workspace._id), crmSettings: workspace.crmSettings } });
}

async function setAssignmentLockMinutes(req, res) {
  const payload = await assignmentLockSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspace = await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  workspace.crmSettings = workspace.crmSettings || {};
  workspace.crmSettings.assignmentLockMinutes = Number(payload.assignmentLockMinutes);
  await workspace.save();

  await writeAuditLog(req, {
    action: "crm.workspace.settings.assignmentLockMinutes",
    resourceType: "workspace",
    resourceId: String(workspace._id),
    metadata: { assignmentLockMinutes: workspace.crmSettings.assignmentLockMinutes },
  });

  res.json({ success: true, workspace: { id: String(workspace._id), crmSettings: workspace.crmSettings } });
}

async function listEmployees(req, res) {
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const items = await Employee.find({ workspaceId: req.workspace.id, status: { $ne: "DELETED" } })
    .sort({ createdAt: -1 })
    .select("_id email name role status permissions assignedChatsCount lastLoginAt lastActivityAt createdAt");
  res.json({
    success: true,
    items: items.map((e) => ({
      id: String(e._id),
      email: e.email,
      name: e.name || "",
      role: e.role || "employee",
      status: e.status,
      permissions: e.permissions || {},
      assignedChatsCount: Number(e.assignedChatsCount || 0),
      lastLoginAt: e.lastLoginAt || null,
      lastActivityAt: e.lastActivityAt || null,
      createdAt: e.createdAt,
    })),
  });
}

async function createEmployee(req, res) {
  const payload = await createEmployeeSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspace = await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  if (!workspace.crmEnabled) throw new HttpError(403, "CRM is disabled for this workspace");

  const owner = await User.findById(workspace.ownerId).select("email name");
  if (!owner) throw new HttpError(404, "Workspace owner not found");

  const email = String(payload.email).trim().toLowerCase();

  const existing = await Employee.findOne({ workspaceId: req.workspace.id, email }).select("_id status deletedAt");
  if (existing) {
    const status = String(existing.status || "ACTIVE").toUpperCase();
    if (existing.deletedAt || status === "DELETED") {
      throw new HttpError(
        409,
        "This employee email was previously deleted (fired) and cannot be used again. Please use a different email."
      );
    }
    if (status === "BLOCKED") {
      throw new HttpError(409, "An employee with this email already exists and is blocked. Unblock the employee to reuse.");
    }
    if (status === "DISABLED") {
      throw new HttpError(409, "An employee with this email already exists and is disabled. Enable the employee to reuse.");
    }
    throw new HttpError(409, "An employee with this email already exists.");
  }

  // Set an unknown random password hash; employee must set their own password via the invite link.
  const password = randomPassword() + crypto.randomBytes(18).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 10);

  const employee = await Employee.create({
    workspaceId: req.workspace.id,
    email,
    passwordHash,
    name: payload.name || "",
    role: payload.role || "employee",
    twoFactorEnabled: true,
    permissions: payload.permissions || undefined,
    createdBy: req.user.id,
  });

  // Issue a one-time "set password" token (invite). Never email the password to anyone.
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await employeeRepo.setPasswordResetToken({ workspaceId: req.workspace.id, employeeId: employee._id, tokenHash, expiresAt });

  const appBase = String(appBaseUrl || "").replace(/\/+$/, "");
  const resetLink = `${appBase}/employee/reset-password?token=${encodeURIComponent(rawToken)}`;

  const employeeSubject = "Set your CRM employee password";
  const employeeHtml = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
      <h2 style="margin:0 0 12px">Employee Access</h2>
      <p>Workspace: <b>${String(workspace.name || "")}</b></p>
      <p>Email: <b>${email}</b></p>
      <p>Click the link below to set your password:</p>
      <p><a href="${resetLink}">Set Password</a></p>
      <p style="font-size:12px;color:#64748b">This link expires in 24 hours.</p>
    </div>
  `;
  const employeeText = `Workspace: ${workspace.name}\nEmail: ${email}\nSet password: ${resetLink}\n`;

  const ownerSubject = "CRM employee created";
  const ownerHtml = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
      <h2 style="margin:0 0 12px">Employee Created</h2>
      <p>Workspace: <b>${String(workspace.name || "")}</b></p>
      <p>Email: <b>${email}</b></p>
      <p style="font-size:12px;color:#64748b">A password setup link was sent to the employee email.</p>
    </div>
  `;
  const ownerText = `Workspace: ${workspace.name}\nEmployee email: ${email}\nPassword setup link was sent to the employee.\n`;

  await Promise.allSettled([
    sendEmail({
      toEmail: email,
      toName: payload.name || "",
      subject: employeeSubject,
      htmlContent: employeeHtml,
      textContent: employeeText,
    }),
    sendEmail({ toEmail: owner.email, toName: owner.name || "", subject: ownerSubject, htmlContent: ownerHtml, textContent: ownerText }),
  ]);

  await writeAuditLog(req, {
    action: "crm.employee.create",
    resourceType: "crm_employee",
    resourceId: String(employee._id),
    metadata: { workspaceId: req.workspace.id, email },
  });

  res.json({ success: true, employee: { id: String(employee._id), email: employee.email, name: employee.name || "" } });
}

async function updateEmployeeStatus(req, res) {
  const payload = await updateEmployeeStatusSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();
  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select("_id status deletedAt");
  if (!employee) throw new HttpError(404, "Employee not found");

  employee.status = payload.status;
  if (payload.status === "DELETED") employee.deletedAt = new Date();
  await employee.save();

  await writeAuditLog(req, {
    action: "crm.employee.status",
    resourceType: "crm_employee",
    resourceId: String(employee._id),
    metadata: { status: employee.status },
  });

  res.json({ success: true });
}

module.exports = {
  getWorkspaceCrm,
  setLeadWindowHours,
  setAssignmentLockMinutes,
  listEmployees,
  createEmployee,
  updateEmployeeStatus,
};
