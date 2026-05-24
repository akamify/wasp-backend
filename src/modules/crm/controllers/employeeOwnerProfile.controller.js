const Joi = require("joi");
const { HttpError } = require("@shared/utils/httpError");
const { Workspace } = require("@infra/database/Workspace");
const { Employee } = require("@infra/database/Employee");
const { User } = require("@infra/database/User");
const { CrmLead } = require("@infra/database/CrmLead");
const { CrmAssignmentAudit } = require("@infra/database/CrmAssignmentAudit");
const { EmployeeLoginEvent } = require("@infra/database/EmployeeLoginEvent");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const bcrypt = require("bcryptjs");
const employeeAuthService = require("@modules/crm/services/employeeAuth.service");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { Conversation } = require("@infra/database/Conversation");

async function requireActiveCrmWorkspaceForOwner({ workspaceId, ownerId }) {
  const workspace = await Workspace.findOne({ _id: workspaceId, ownerId, isActive: true }).select(
    "_id ownerId name isActive crmEnabled"
  );
  if (!workspace) throw new HttpError(404, "Workspace not found");
  if (!workspace.crmEnabled) throw new HttpError(403, "CRM is disabled for this workspace");
  return workspace;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function isoDay(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function buildLastNDays(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(isoDay(daysAgo(i)));
  }
  return out;
}

function fillSeries(days, rows) {
  const map = new Map((rows || []).map((r) => [String(r._id || ""), Number(r.count || 0)]));
  return days.map((day) => ({ day, count: map.get(day) || 0 }));
}

async function getEmployeeProfile(req, res) {
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();
  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select(
    "_id email name role status permissions assignedChatsCount lastLoginAt lastActivityAt createdAt updatedAt deletedAt"
  );
  if (!employee) throw new HttpError(404, "Employee not found");

  const today = startOfToday();
  const since7d = daysAgo(7);

  const last7Days = buildLastNDays(7);

  const [leadsTotal, leadsToday, leads7d, openLeads, closedLeads, assignedConversations, assignedSeriesRaw, closedSeriesRaw] = await Promise.all([
    CrmLead.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: employee._id }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: employee._id, assignedAt: { $gte: today } }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: employee._id, assignedAt: { $gte: since7d } }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: employee._id, status: "OPEN" }),
    CrmLead.countDocuments({
      workspaceId: req.workspace.id,
      assignedEmployeeId: employee._id,
      $or: [{ status: "CLOSED" }, { closedAt: { $ne: null } }],
    }),
    Conversation.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: employee._id }),
    CrmLead.aggregate([
      {
        $match: {
          workspaceId: employee.workspaceId,
          assignedEmployeeId: employee._id,
          $or: [{ assignedAt: { $gte: since7d } }, { createdAt: { $gte: since7d } }],
        },
      },
      {
        $addFields: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $ifNull: ["$assignedAt", "$createdAt"] },
            },
          },
        },
      },
      { $group: { _id: "$day", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    CrmLead.aggregate([
      {
        $match: {
          workspaceId: employee.workspaceId,
          assignedEmployeeId: employee._id,
          closedAt: { $gte: since7d },
        },
      },
      {
        $addFields: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$closedAt",
            },
          },
        },
      },
      { $group: { _id: "$day", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  res.json({
    success: true,
    employee: {
      id: String(employee._id),
      email: employee.email,
      name: employee.name || "",
      role: employee.role || "employee",
      status: employee.status,
      assignedChatsCount: Number(employee.assignedChatsCount || 0),
      lastLoginAt: employee.lastLoginAt || null,
      lastActivityAt: employee.lastActivityAt || null,
      createdAt: employee.createdAt || null,
      updatedAt: employee.updatedAt || null,
      deletedAt: employee.deletedAt || null,
    },
    metrics: {
      leadsAssigned: { total: leadsTotal, today: leadsToday, last7Days: leads7d },
      leadsOpen: { total: openLeads },
      leadsClosed: { total: closedLeads },
      conversationsAssigned: { total: assignedConversations },
      series: {
        assignedLast7Days: fillSeries(last7Days, assignedSeriesRaw),
        closedLast7Days: fillSeries(last7Days, closedSeriesRaw),
      },
    },
  });
}

const updateEmployeeSchema = Joi.object({
  name: Joi.string().allow("").max(120).optional(),
  role: Joi.string().valid("employee", "team_leader").allow("").optional(),
  email: Joi.string().email().optional(),
});

async function updateEmployeeProfile(req, res) {
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();
  const payload = await updateEmployeeSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });

  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select("_id email name role status deletedAt");
  if (!employee) throw new HttpError(404, "Employee not found");

  if (payload.email) {
      const nextEmail = String(payload.email).trim().toLowerCase();
    if (nextEmail !== String(employee.email || "").toLowerCase()) {
      // Prevent collisions with platform identities (user/admin/super_admin).
      const existingUser = await User.findOne({ email: nextEmail }).select("_id role email");
      if (existingUser) throw new HttpError(409, "An employee with this email already exists.");

      const existing = await Employee.findOne({ workspaceId: req.workspace.id, email: nextEmail }).select("_id status deletedAt");
      if (existing) {
        const status = String(existing.status || "ACTIVE").toUpperCase();
        if (existing.deletedAt || status === "DELETED") {
          throw new HttpError(
            409,
            "This employee email was previously deleted (fired) and cannot be used again. Please use a different email."
          );
        }
        throw new HttpError(409, "An employee with this email already exists.");
      }
      employee.email = nextEmail;
    }
  }
  if (payload.name !== undefined) employee.name = String(payload.name || "");
  if (payload.role !== undefined) employee.role = String(payload.role || "") || "employee";

  await employee.save();
  res.json({
    success: true,
    employee: { id: String(employee._id), email: employee.email, name: employee.name || "", role: employee.role || "employee" },
  });
}

async function listEmployeeLeads(req, res) {
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();
  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select("_id");
  if (!employee) throw new HttpError(404, "Employee not found");

  const range = String(req.query?.range || "all");
  const page = Math.max(1, Number(req.query?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 25)));
  const skip = (page - 1) * limit;

  const q = { workspaceId: req.workspace.id, assignedEmployeeId: employee._id };
  if (range === "today") q.assignedAt = { $gte: startOfToday() };
  if (range === "7d") q.assignedAt = { $gte: daysAgo(7) };

  const [items, total] = await Promise.all([
    CrmLead.find(q).sort({ assignedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    CrmLead.countDocuments(q),
  ]);

  res.json({
    success: true,
    page,
    limit,
    total,
    items: (items || []).map((l) => ({
      id: String(l._id),
      phone: l.phone,
      status: l.status,
      assignedAt: l.assignedAt || null,
      lastInboundAt: l.lastInboundAt || null,
      firstInboundAt: l.firstInboundAt || null,
      createdAt: l.createdAt || null,
      updatedAt: l.updatedAt || null,
    })),
  });
}

async function listEmployeeActivities(req, res) {
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();
  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select("_id");
  if (!employee) throw new HttpError(404, "Employee not found");

  const page = Math.max(1, Number(req.query?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 25)));
  const skip = (page - 1) * limit;

  const q = {
    workspaceId: req.workspace.id,
    $or: [{ fromEmployeeId: employee._id }, { toEmployeeId: employee._id }],
  };

  const [items, total] = await Promise.all([
    CrmAssignmentAudit.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CrmAssignmentAudit.countDocuments(q),
  ]);

  res.json({
    success: true,
    page,
    limit,
    total,
    items: (items || []).map((a) => ({
      id: String(a._id),
      phone: a.phone,
      fromEmployeeId: a.fromEmployeeId ? String(a.fromEmployeeId) : null,
      toEmployeeId: a.toEmployeeId ? String(a.toEmployeeId) : null,
      mode: a.mode || "",
      reason: a.reason || "",
      assignedBy: a.assignedBy || null,
      createdAt: a.createdAt || null,
    })),
  });
}

async function listEmployeeSessions(req, res) {
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();
  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select("_id");
  if (!employee) throw new HttpError(404, "Employee not found");

  const page = Math.max(1, Number(req.query?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 25)));
  const skip = (page - 1) * limit;

  const q = { workspaceId: req.workspace.id, employeeId: employee._id };
  const [items, total] = await Promise.all([
    EmployeeLoginEvent.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    EmployeeLoginEvent.countDocuments(q),
  ]);

  res.json({
    success: true,
    page,
    limit,
    total,
    items: (items || []).map((e) => ({
      id: String(e._id),
      type: e.type,
      ip: e.ip || "",
      userAgent: e.userAgent || "",
      createdAt: e.createdAt || null,
    })),
  });
}

module.exports = {
  getEmployeeProfile: asyncHandler(getEmployeeProfile),
  updateEmployeeProfile: asyncHandler(updateEmployeeProfile),
  sendEmployeePasswordResetLink: asyncHandler(async (req, res) => {
    await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
    const employeeId = String(req.params.employeeId || "").trim();
    const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select("_id email name status deletedAt");
    if (!employee) throw new HttpError(404, "Employee not found");

    await employeeAuthService.forgotEmployeePassword({ workspaceId: req.workspace.id, email: employee.email });

    await writeAuditLog(req, {
      action: "crm.employee.password_reset_link_sent",
      resourceType: "crm_employee",
      resourceId: String(employee._id),
      metadata: { workspaceId: String(req.workspace.id), employeeId: String(employee._id) },
    });

    res.json({ success: true, message: "Reset link sent (if employee is active)." });
  }),
  setEmployeePasswordDirect: asyncHandler(async (req, res) => {
    const newPassword = String(req.body?.newPassword || "");
    if (newPassword.length < 8) throw new HttpError(400, "New password must be at least 8 characters");

    await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
    const employeeId = String(req.params.employeeId || "").trim();
    const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select(
      "_id email name status deletedAt +passwordHash sessionVersion"
    );
    if (!employee) throw new HttpError(404, "Employee not found");

    employee.passwordHash = await bcrypt.hash(newPassword, 12);
    employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
    await employee.save();

    await writeAuditLog(req, {
      action: "crm.employee.password_reset_direct",
      resourceType: "crm_employee",
      resourceId: String(employee._id),
      metadata: { workspaceId: String(req.workspace.id), employeeId: String(employee._id) },
    });

    res.json({ success: true, message: "Employee password updated successfully." });
  }),
  listEmployeeLeads: asyncHandler(listEmployeeLeads),
  listEmployeeActivities: asyncHandler(listEmployeeActivities),
  listEmployeeSessions: asyncHandler(listEmployeeSessions),
};
