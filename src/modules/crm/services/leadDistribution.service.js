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

module.exports = {
  pickRoundRobinEmployee,
};

