const { HttpError } = require("@shared/utils/httpError");
const { CrmLead } = require("@infra/database/CrmLead");
const { asyncHandler } = require("@shared/utils/asyncHandler");

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function listEmployeeLeads(req, res) {
  if (!req.employee?.id) throw new HttpError(401, "Unauthorized");
  const range = String(req.query?.range || "all");
  const page = Math.max(1, Number(req.query?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 25)));
  const skip = (page - 1) * limit;

  const q = { workspaceId: req.workspace.id, assignedEmployeeId: req.employee.id };
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

module.exports = {
  listEmployeeLeads: asyncHandler(listEmployeeLeads),
};

