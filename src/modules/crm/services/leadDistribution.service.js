const { createRedisConnection } = require("@infra/redis/redisClient");
const { Employee } = require("@infra/database/Employee");

async function pickRoundRobinEmployee({ workspaceId }) {
  const employees = await Employee.find({ workspaceId, status: "ACTIVE", deletedAt: null }).select("_id").lean();
  if (!employees.length) return null;

  const redis = createRedisConnection();
  const n = await redis.incr(`crm:rr:${String(workspaceId)}`);
  const idx = (Number(n || 1) - 1) % employees.length;
  return String(employees[idx]._id);
}

async function pickLeastActiveEmployee({ workspaceId }) {
  const employees = await Employee.find({ workspaceId, status: "ACTIVE", deletedAt: null })
    .sort({ assignedChatsCount: 1, lastActivityAt: 1, createdAt: 1 })
    .select("_id")
    .lean();
  if (!employees.length) return null;
  return String(employees[0]._id);
}

async function pickFixedLimitEmployee({ workspaceId }) {
  const employees = await Employee.find({ workspaceId, status: "ACTIVE", deletedAt: null })
    .sort({ assignedChatsCount: 1, createdAt: 1 })
    .select("_id assignedChatsCount maxActiveLeads")
    .lean();
  if (!employees.length) return null;

  const eligible = employees.filter((e) => {
    const max = Number(e.maxActiveLeads);
    if (!Number.isFinite(max) || max <= 0) return true;
    return Number(e.assignedChatsCount || 0) < max;
  });
  if (!eligible.length) return null;
  return String(eligible[0]._id);
}

async function pickEmployeeByMode({ workspaceId, mode }) {
  const m = String(mode || "ROUND_ROBIN").toUpperCase();
  if (m === "LEAST_ACTIVE") return pickLeastActiveEmployee({ workspaceId });
  if (m === "FIXED_LIMIT") return pickFixedLimitEmployee({ workspaceId });
  if (m === "MANUAL") return null;
  return pickRoundRobinEmployee({ workspaceId });
}

module.exports = {
  pickRoundRobinEmployee,
  pickLeastActiveEmployee,
  pickFixedLimitEmployee,
  pickEmployeeByMode,
};
