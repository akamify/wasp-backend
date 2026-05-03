const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { getRedisUrl } = require("../config/redis");

let _connection;
let _lastLoggedRedisErrorKey = null;
let _lastLoggedRedisErrorAt = 0;

function logRedisErrorOnce(err) {
  const code = err?.code || "";
  const msg = err?.message || String(err || "");
  const key = `${code}::${msg}`;
  const now = Date.now();
  if (key === _lastLoggedRedisErrorKey && now - _lastLoggedRedisErrorAt < 30_000) return;
  _lastLoggedRedisErrorKey = key;
  _lastLoggedRedisErrorAt = now;
  // eslint-disable-next-line no-console
  console.error("Redis connection error:", code || msg);
}

function getRedisConnection() {
  if (_connection) return _connection;

  if (String(process.env.DISABLE_REDIS || "").toLowerCase() === "true") {
    throw new Error("Redis is disabled (set DISABLE_REDIS=false to enable)");
  }

  const redisUrl = getRedisUrl();
  const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  // Upstash typically requires TLS; when users paste a `redis://...upstash.io:6379` URL,
  // the server often resets the connection (ECONNRESET). Auto-enable TLS for known hosts.
  try {
    const u = new URL(redisUrl);
    const needsTls =
      u.protocol === "rediss:" ||
      String(u.hostname || "").toLowerCase().endsWith("upstash.io") ||
      String(process.env.REDIS_TLS || "").toLowerCase() === "true";
    if (needsTls) options.tls = {};
  } catch (_) {
    // If parsing fails, fall back to plain connection options.
  }

  // Avoid hot-loop reconnect spam when DNS is flaky locally.
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") {
    options.retryStrategy = (times) => {
      if (times > 10) return null; // stop retrying after some attempts in dev
      return Math.min(1000 * times, 10_000);
    };
  }

  _connection = new IORedis(redisUrl, options);

  // Prevent noisy unhandled error stacks while still surfacing the root cause.
  _connection.on("error", (err) => {
    logRedisErrorOnce(err);
  });
  return _connection;
}

function createQueue(name) {
  return new Queue(name, { connection: getRedisConnection() });
}

module.exports = { getRedisConnection, createQueue };
