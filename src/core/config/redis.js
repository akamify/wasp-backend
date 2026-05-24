const { HttpError } = require("@shared/utils/httpError");

function getRedisUrl() {
  const redisUrl = String(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || "").trim();
  const restUrl = String(process.env.UPSTASH_REDIS_REST_URL || "").trim();

  // Upstash REST URL is for HTTP API; BullMQ/ioredis requires redis:// or rediss:// URL.
  if (!redisUrl && restUrl) {
    throw new HttpError(
      500,
      "Invalid Redis configuration: use REDIS_URL or UPSTASH_REDIS_URL (redis:// / rediss://), not UPSTASH_REDIS_REST_URL."
    );
  }

  const url = redisUrl;
  if (!url && process.env.NODE_ENV === "production") {
    throw new HttpError(500, "REDIS_URL not configured");
  }
  return url || "redis://127.0.0.1:6379";
}

module.exports = { getRedisUrl };

