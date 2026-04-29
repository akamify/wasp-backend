const { HttpError } = require("../utils/httpError");

function getRedisUrl() {
  const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  if (!url && process.env.NODE_ENV === "production") {
    throw new HttpError(500, "REDIS_URL not configured");
  }
  return url || "redis://127.0.0.1:6379";
}

module.exports = { getRedisUrl };

