const IORedis = require("ioredis");
const { getRedisUrl, isRedisDisabled } = require("@core/config/redis");
const logger = require("@core/logger/logger");

let _connection;
let _realtimePublisher;
let _realtimeSubscriber;
let _lastLoggedRedisErrorKey = null;
let _lastLoggedRedisErrorAt = 0;

function isRedisQuotaExceededError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("max requests limit exceeded");
}

function logRedisErrorOnce(err) {
    const code = err?.code || "";
    const msg = err?.message || String(err || "");
    const key = `${code}::${msg}`;
    const now = Date.now();
    if (key === _lastLoggedRedisErrorKey && now - _lastLoggedRedisErrorAt < 60_000) return;
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

    if (isRedisDisabled()) {
        throw new Error("Redis is disabled (set DISABLE_REDIS=false to enable)");
    }

    const redisUrl = getRedisUrl();
    const options = buildRedisOptions(redisUrl);
    _connection = new IORedis(redisUrl, options);

    _connection.on("error", (err) => {
        logRedisErrorOnce(err);
        if (!isRedisQuotaExceededError(err)) return;
        logger.error("[redis] max requests limit exceeded; Redis-dependent work will retry without restarting the process");
    });

    return _connection;
}

function createRealtimeRedisConnections() {
    const connection = createRedisConnection();
    if (!_realtimePublisher) {
        _realtimePublisher = connection.duplicate();
        _realtimePublisher.on("error", logRedisErrorOnce);
    }
    if (!_realtimeSubscriber) {
        _realtimeSubscriber = connection.duplicate();
        _realtimeSubscriber.on("error", logRedisErrorOnce);
    }
    return { publisher: _realtimePublisher, subscriber: _realtimeSubscriber };
}

async function closeRedisConnection() {
    const realtimeConnections = [_realtimePublisher, _realtimeSubscriber].filter(Boolean);
    _realtimePublisher = null;
    _realtimeSubscriber = null;
    await Promise.all(realtimeConnections.map(async (conn) => {
        try {
            await conn.quit();
        } catch (_) {
            try { conn.disconnect(false); } catch (_) { /* ignore */ }
        }
    }));
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

module.exports = { createRedisConnection, createRealtimeRedisConnections, closeRedisConnection };

