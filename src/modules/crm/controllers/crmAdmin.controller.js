const Joi = require("joi");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { Employee } = require("@infra/database/Employee");
const { HttpError } = require("@shared/utils/httpError");
const { sendEmail } = require("@shared/services/emailService");
const { writeAuditLog } = require("@shared/services/auditLog.service");

function randomPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = `${upper}${lower}${digits}${special}`;
  const pick = (chars) => chars[Math.floor(Math.random() * chars.length)];
  let pass = [pick(upper), pick(lower), pick(digits), pick(special)];
  while (pass.length < 8) pass.push(pick(all));
  for (let i = pass.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pass[i], pass[j]] = [pass[j], pass[i]];
  }
  return pass.join("");
}

const toggleCrmSchema = Joi.object({
  enabled: Joi.boolean().required(),
});

async function setCrmEnabled(req, res) {
  const payload = await toggleCrmSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspaceId = String(req.params.workspaceId || "").trim();
  const workspace = await Workspace.findById(workspaceId).select("_id ownerId crmEnabled crmSettings isActive name plan");
  if (!workspace || !workspace.isActive) throw new HttpError(404, "Workspace not found");

  workspace.crmEnabled = Boolean(payload.enabled);
  await workspace.save();

  await writeAuditLog(req, {
    action: "crm.workspace.toggle",
    resourceType: "workspace",
    resourceId: String(workspace._id),
    metadata: { crmEnabled: workspace.crmEnabled },
  });

  res.json({ success: true, workspace: { id: String(workspace._id), crmEnabled: workspace.crmEnabled } });
}

const leadWindowSchema = Joi.object({
  leadWindowHours: Joi.number().integer().min(1).max(720).required(),
});

async function setLeadWindowHours(req, res) {
  const payload = await leadWindowSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspaceId = String(req.params.workspaceId || "").trim();
  const workspace = await Workspace.findById(workspaceId).select("_id ownerId crmSettings isActive");
  if (!workspace || !workspace.isActive) throw new HttpError(404, "Workspace not found");

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

async function listEmployees(req, res) {
  const workspaceId = String(req.params.workspaceId || "").trim();
  const items = await Employee.find({ workspaceId, status: { $ne: "DELETED" } })
    .sort({ createdAt: -1 })
    .select("_id email name role status permissions assignedChatsCount lastLoginAt lastActivityAt createdAt");
  res.json({
    success: true,
    items: items.map((e) => ({
      id: String(e._id),
      email: e.email,
      name: e.name || "",
      role: e.role || "agent",
      status: e.status,
      permissions: e.permissions || {},
      assignedChatsCount: Number(e.assignedChatsCount || 0),
      lastLoginAt: e.lastLoginAt || null,
      lastActivityAt: e.lastActivityAt || null,
      createdAt: e.createdAt,
    })),
  });
}

const createEmployeeSchema = Joi.object({
  email: Joi.string().email().required(),
  name: Joi.string().allow("").max(100).optional(),
  role: Joi.string().allow("").max(50).optional(),
  permissions: Joi.object().unknown(true).optional(),
});

async function createEmployee(req, res) {
  const payload = await createEmployeeSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspaceId = String(req.params.workspaceId || "").trim();
  const workspace = await Workspace.findById(workspaceId).select("_id ownerId name isActive");
  if (!workspace || !workspace.isActive) throw new HttpError(404, "Workspace not found");

  const owner = await User.findById(workspace.ownerId).select("email name");
  if (!owner) throw new HttpError(404, "Workspace owner not found");

  const password = randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const email = String(payload.email).trim().toLowerCase();

  const employee = await Employee.create({
    workspaceId,
    email,
    passwordHash,
    name: payload.name || "",
    role: payload.role || "agent",
    twoFactorEnabled: true,
    permissions: payload.permissions || undefined,
    createdBy: req.user.id,
  });

  const subject = "CRM Employee account created";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
      <h2 style="margin:0 0 12px">Employee Access</h2>
      <p>Workspace: <b>${String(workspace.name || "")}</b></p>
      <p>Email: <b>${email}</b></p>
      <p>Password: <b>${password}</b></p>
      <p>2FA is enabled by default.</p>
      <p style="font-size:12px;color:#64748b">Please change the password after first login.</p>
    </div>
  `;
  const text = `Workspace: ${workspace.name}\nEmail: ${email}\nPassword: ${password}\n2FA: enabled by default\n`;

  // Email both owner and employee (best-effort; do not block creation).
  await Promise.allSettled([
    sendEmail({ toEmail: email, toName: payload.name || "", subject, htmlContent: html, textContent: text }),
    sendEmail({ toEmail: owner.email, toName: owner.name || "", subject, htmlContent: html, textContent: text }),
  ]);

  await writeAuditLog(req, {
    action: "crm.employee.create",
    resourceType: "crm_employee",
    resourceId: String(employee._id),
    metadata: { workspaceId, email },
  });

  res.json({ success: true, employee: { id: String(employee._id), email: employee.email, name: employee.name || "" } });
}

const updateEmployeeStatusSchema = Joi.object({
  status: Joi.string().valid("ACTIVE", "BLOCKED", "DISABLED", "DELETED").required(),
});

async function updateEmployeeStatus(req, res) {
  const payload = await updateEmployeeStatusSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspaceId = String(req.params.workspaceId || "").trim();
  const employeeId = String(req.params.employeeId || "").trim();
  const employee = await Employee.findOne({ _id: employeeId, workspaceId }).select("_id status deletedAt");
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
  async getWorkspaceCrm(req, res) {
    const workspaceId = String(req.params.workspaceId || "").trim();
    const workspace = await Workspace.findById(workspaceId).select("_id name plan isActive crmEnabled crmSettings ownerId");
    if (!workspace || !workspace.isActive) throw new HttpError(404, "Workspace not found");
    const employeesCount = await Employee.countDocuments({ workspaceId, status: { $ne: "DELETED" } });
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
  },
  setCrmEnabled,
  setLeadWindowHours,
  listEmployees,
  createEmployee,
  updateEmployeeStatus,
};
