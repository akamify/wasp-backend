const IORedis = require("ioredis");
const { getRedisUrl } = require("@core/config/redis");
const logger = require("@core/logger/logger");

let _connection;
let _lastLoggedRedisErrorKey = null;
let _lastLoggedRedisErrorAt = 0;
let _quotaExceededHandled = false;

function isRedisQuotaExceededError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("max requests limit exceeded");
}

function logRedisErrorOnce(err) {
    const code = err?.code || "";
    const msg = err?.message || String(err || "");
    const key = `${code}::${msg}`;
    const now = Date.now();
    if (key === _lastLoggedRedisErrorKey && now - _lastLoggedRedisErrorAt < 30_000) return;
    _lastLoggedRedisErrorKey = key;
    _lastLoggedRedisErrorAt = now;
    logger.error("Redis connection error", { code, message: msg });
}

function buildRedisOptions(redisUrl) {
    const options = {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };

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

    if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") {
        options.retryStrategy = (times) => {
            if (times > 10) return null;
            return Math.min(1000 * times, 10_000);
        };
    }

    return options;
}

function createRedisConnection() {
    if (_connection) return _connection;

    if (String(process.env.DISABLE_REDIS || "").toLowerCase() === "true") {
        throw new Error("Redis is disabled (set DISABLE_REDIS=false to enable)");
    }

    const redisUrl = getRedisUrl();
    const options = buildRedisOptions(redisUrl);
    _connection = new IORedis(redisUrl, options);

    _connection.on("error", (err) => {
        logRedisErrorOnce(err);
        if (_quotaExceededHandled) return;
        if (!isRedisQuotaExceededError(err)) return;

        _quotaExceededHandled = true;
        logger.error("Redis quota exceeded. Stopping Redis-dependent processing to avoid hot loop.", {
            hint: "Increase Upstash plan limit or rotate Redis URL.",
        });

        try {
            _connection.disconnect(false);
        } catch (_) {
            // ignore
        }

        // Worker process should fail fast so it does not keep hammering Redis.
        if (String(process.env.WORKER_PROCESS || "").toLowerCase() === "true") {
            setTimeout(() => process.exit(1), 200);
        }
    });

    return _connection;
}

async function closeRedisConnection() {
    if (!_connection) return;
    const conn = _connection;
    _connection = null;
    try {
        await conn.quit();
    } catch (_) {
        try {
            conn.disconnect(false);
        } catch (_) {
            // ignore
        }
    }
}

module.exports = { createRedisConnection, closeRedisConnection };

