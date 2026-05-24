const { Workspace } = require("@infra/database/Workspace");
const { Employee } = require("@infra/database/Employee");
const { CrmLead } = require("@infra/database/CrmLead");
const { CrmAssignmentAudit } = require("@infra/database/CrmAssignmentAudit");
const { EmployeeLoginEvent } = require("@infra/database/EmployeeLoginEvent");
const { HttpError } = require("@shared/utils/httpError");

function startOfDayISO(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  d.setHours(0, 0, 0, 0);
  return d;
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
  for (let i = days - 1; i >= 0; i -= 1) out.push(isoDay(startOfDayISO(i)));
  return out;
}

function fillSeries(days, rows) {
  const map = new Map((rows || []).map((r) => [String(r._id || ""), Number(r.count || 0)]));
  return days.map((day) => ({ day, count: map.get(day) || 0 }));
}

async function getDashboard(req, res) {
  const workspace = await Workspace.findOne({ _id: req.workspace.id, ownerId: req.user.id, isActive: true }).select(
    "_id name plan isActive crmEnabled crmSettings"
  );
  if (!workspace) throw new HttpError(404, "Workspace not found");
  if (!workspace.crmEnabled) throw new HttpError(403, "CRM is disabled for this workspace");

  const now = new Date();
  const activeThresholdMs = 10 * 60 * 1000;
  const activeSince = new Date(Date.now() - activeThresholdMs);

  const days = buildLastNDays(7);
  const since7d = startOfDayISO(6);

  const [
    employeesTotal,
    employeesActiveNow,
    leadsTotal,
    leadsAssigned,
    leadsUnassigned,
    leadsClosed,
    leadsPending,
    assignedSeriesRaw,
    unassignedSeriesRaw,
    closedSeriesRaw,
    pendingSeriesRaw,
    recentAssignments,
    recentSessions,
  ] = await Promise.all([
    Employee.countDocuments({ workspaceId: req.workspace.id, status: { $ne: "DELETED" } }),
    Employee.countDocuments({
      workspaceId: req.workspace.id,
      status: "ACTIVE",
      deletedAt: null,
      lastActivityAt: { $gte: activeSince },
    }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: { $ne: null } }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id, assignedEmployeeId: null }),
    CrmLead.countDocuments({
      workspaceId: req.workspace.id,
      $or: [{ status: { $in: ["CLOSED", "WON", "LOST"] } }, { closedAt: { $ne: null } }],
    }),
    CrmLead.countDocuments({ workspaceId: req.workspace.id, status: "PENDING" }),
    CrmLead.aggregate([
      { $match: { workspaceId: workspace._id, assignedAt: { $gte: since7d } } },
      {
        $addFields: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$assignedAt" } },
        },
      },
      { $group: { _id: "$day", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    CrmLead.aggregate([
      { $match: { workspaceId: workspace._id, assignedEmployeeId: null, createdAt: { $gte: since7d } } },
      {
        $addFields: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        },
      },
      { $group: { _id: "$day", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    CrmLead.aggregate([
      { $match: { workspaceId: workspace._id, closedAt: { $gte: since7d } } },
      {
        $addFields: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$closedAt" } },
        },
      },
      { $group: { _id: "$day", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    CrmLead.aggregate([
      { $match: { workspaceId: workspace._id, status: "PENDING", createdAt: { $gte: since7d } } },
      {
        $addFields: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        },
      },
      { $group: { _id: "$day", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    CrmAssignmentAudit.find({ workspaceId: req.workspace.id }).sort({ createdAt: -1 }).limit(10).lean(),
    EmployeeLoginEvent.find({ workspaceId: req.workspace.id }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const employeeIds = Array.from(
    new Set(
      []
        .concat(recentAssignments.map((a) => (a.fromEmployeeId ? String(a.fromEmployeeId) : "")))
        .concat(recentAssignments.map((a) => (a.toEmployeeId ? String(a.toEmployeeId) : "")))
        .concat(recentSessions.map((s) => (s.employeeId ? String(s.employeeId) : "")))
        .filter(Boolean)
    )
  );
  const employees = employeeIds.length
    ? await Employee.find({ _id: { $in: employeeIds }, workspaceId: req.workspace.id }).select("_id name email").lean()
    : [];
  const employeeMap = new Map(employees.map((e) => [String(e._id), e]));

  const activityFeed = []
    .concat(
      (recentAssignments || []).map((a) => ({
        type: "assignment",
        at: a.createdAt || null,
        phone: a.phone || "",
        mode: a.mode || "",
        reason: a.reason || "",
        fromEmployee: a.fromEmployeeId ? employeeMap.get(String(a.fromEmployeeId)) : null,
        toEmployee: a.toEmployeeId ? employeeMap.get(String(a.toEmployeeId)) : null,
      }))
    )
    .concat(
      (recentSessions || []).map((s) => ({
        type: "session",
        at: s.createdAt || null,
        sessionType: s.type || "",
        employee: s.employeeId ? employeeMap.get(String(s.employeeId)) : null,
      }))
    )
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())
    .slice(0, 10);

  res.json({
    success: true,
    dashboard: {
      workspace: {
        id: String(workspace._id),
        name: workspace.name || "",
        plan: workspace.plan || "",
      },
      settings: {
        leadWindowHours: Number(workspace.crmSettings?.leadWindowHours || 22),
        assignmentLockMinutes: Number(workspace.crmSettings?.assignmentLockMinutes || 5),
        autoAssignEnabled: workspace.crmSettings?.autoAssignEnabled !== false,
        assignmentMode: String(workspace.crmSettings?.assignmentMode || "ROUND_ROBIN"),
      },
      employees: {
        total: Number(employeesTotal || 0),
        activeNow: Number(employeesActiveNow || 0),
        activeWindowMinutes: Math.round(activeThresholdMs / 60000),
      },
      leads: {
        total: Number(leadsTotal || 0),
        assigned: Number(leadsAssigned || 0),
        unassigned: Number(leadsUnassigned || 0),
        closed: Number(leadsClosed || 0),
        pending: Number(leadsPending || 0),
      },
      series: {
        days,
        assigned: fillSeries(days, assignedSeriesRaw),
        unassigned: fillSeries(days, unassignedSeriesRaw),
        closed: fillSeries(days, closedSeriesRaw),
        pending: fillSeries(days, pendingSeriesRaw),
      },
      recentActivities: activityFeed.map((a) => ({
        type: a.type,
        at: a.at,
        ...(a.type === "assignment"
          ? {
              phone: a.phone,
              mode: a.mode,
              reason: a.reason,
              fromEmployee: a.fromEmployee
                ? { id: String(a.fromEmployee._id), name: a.fromEmployee.name || "", email: a.fromEmployee.email }
                : null,
              toEmployee: a.toEmployee ? { id: String(a.toEmployee._id), name: a.toEmployee.name || "", email: a.toEmployee.email } : null,
            }
          : {}),
        ...(a.type === "session"
          ? {
              sessionType: a.sessionType,
              employee: a.employee ? { id: String(a.employee._id), name: a.employee.name || "", email: a.employee.email } : null,
            }
          : {}),
      })),
    },
  });
}

module.exports = {
  getDashboard,
};
