const { HttpError } = require("@shared/utils/httpError");

function isRedisDisabled() {
  return String(process.env.DISABLE_REDIS || "").trim().toLowerCase() === "true";
}

function getRedisConfig() {
  const disabled = isRedisDisabled();
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  if (disabled) {
    return { disabled: true, url: null, protocol: null, redisHost: null, port: null, source: "process.env.REDIS_URL" };
  }
  if (!redisUrl) throw new HttpError(500, "REDIS_URL is required when DISABLE_REDIS=false");

  let parsed;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new HttpError(500, "REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new HttpError(500, "REDIS_URL must use redis:// or rediss://");
  }

  return {
    disabled: false,
    url: redisUrl,
    protocol: parsed.protocol,
    redisHost: parsed.hostname,
    port: parsed.port || "6379",
    source: "process.env.REDIS_URL",
  };
}

function getRedisUrl() {
  const config = getRedisConfig();
  if (config.disabled) throw new HttpError(503, "Redis is disabled (set DISABLE_REDIS=false to enable)");
  return config.url;
}

function logRedisConfig() {
  const config = getRedisConfig();
  console.info("[redis] config", {
    disabled: config.disabled,
    protocol: config.protocol,
    redisHost: config.redisHost,
    port: config.port,
    source: config.source,
  });
  if (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" &&
    String(config.redisHost || "").toLowerCase().includes("upstash.io")
  ) {
    console.warn("[redis] WARNING old Upstash Redis URL still active");
  }
  return config;
}

module.exports = { getRedisConfig, getRedisUrl, isRedisDisabled, logRedisConfig };

