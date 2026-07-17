const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { createRedisConnection } = require("@infra/redis/redisClient");
const logger = require("@core/logger/logger");
const { getWorkspaceEntitlements } = require("@modules/workspaces/services/workspaceEntitlement.service");

const DEFAULT_PHONE_RATE_PER_SEC = Math.max(Number(process.env.CAMPAIGN_PHONE_RATE_LIMIT_PER_SEC_DEFAULT || 5), 1);
const DEFAULT_WABA_RATE_PER_SEC = Math.max(Number(process.env.CAMPAIGN_WABA_RATE_LIMIT_PER_SEC_DEFAULT || 20), 1);
const MAX_WAIT_MS = Math.min(Math.max(Number(process.env.CAMPAIGN_RATE_LIMIT_MAX_WAIT_MS || 60_000), 1000), 5 * 60_000);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseThroughputRate(throughput) {
    if (typeof throughput === "number" && Number.isFinite(throughput) && throughput > 0) return throughput;
    const raw = typeof throughput === "string" ? throughput : JSON.stringify(throughput || "");
    const upper = String(raw || "").toUpperCase();
    const numeric = upper.match(/(\d+(?:\.\d+)?)/);
    if (numeric) return Math.max(Number(numeric[1]), 1);
    if (upper.includes("HIGH")) return 20;
    if (upper.includes("MEDIUM")) return 10;
    if (upper.includes("LOW")) return 3;
    if (upper.includes("STANDARD")) return 5;
    return DEFAULT_PHONE_RATE_PER_SEC;
}

function spacingMs(ratePerSec) {
    return Math.max(Math.ceil(1000 / Math.max(Number(ratePerSec || 1), 1)), 1);
}

async function reserveSlot(redis, key, spacing) {
    const now = Date.now();
    const delay = await redis.eval(
        "local current=tonumber(redis.call('GET', KEYS[1]) or '0'); local now=tonumber(ARGV[1]); local spacing=tonumber(ARGV[2]); local ttl=tonumber(ARGV[3]); local scheduled=math.max(current, now); local nextAt=scheduled+spacing; redis.call('PSETEX', KEYS[1], ttl, tostring(nextAt)); return scheduled-now;",
        1,
        key,
        now,
        spacing,
        Math.max(MAX_WAIT_MS * 2, spacing * 10)
    );
    return Math.max(Number(delay || 0), 0);
}

async function getCampaignRateScope({ workspaceId, wabaId }) {
    const query = { workspaceId, isActive: { $ne: false } };
    if (wabaId) query.wabaId = String(wabaId);
    return WhatsAppCredentials.findOne(query)
        .select("workspaceId wabaId phoneNumberId phoneNumberIdPlain throughput")
        .sort({ connectedAt: -1 })
        .lean();
}

async function waitForCampaignSendSlot({ workspaceId, wabaId }) {
    let connection;
    try {
        connection = await getCampaignRateScope({ workspaceId, wabaId });
        if (!connection) return;
        const phoneNumberId = String(connection.phoneNumberId || connection.phoneNumberIdPlain || "").trim();
        const resolvedWabaId = String(connection.wabaId || wabaId || "").trim();
        if (!phoneNumberId && !resolvedWabaId) return;

        const entitlements = await getWorkspaceEntitlements(workspaceId);
        const planRate = Number(entitlements.limits?.messageRatePerSec || 0);
        const phoneRate = Math.max(
            planRate > 0 ? Math.min(parseThroughputRate(connection.throughput), planRate) : parseThroughputRate(connection.throughput),
            1
        );
        const configuredWabaRate = Math.max(Number(process.env.CAMPAIGN_WABA_RATE_LIMIT_PER_SEC || DEFAULT_WABA_RATE_PER_SEC), 1);
        const wabaRate = Math.max(planRate > 0 ? Math.min(configuredWabaRate, planRate) : configuredWabaRate, 1);
        const redis = createRedisConnection();
        const delays = [];
        if (phoneNumberId) delays.push(await reserveSlot(redis, `campaign:rate:phone:${phoneNumberId}`, spacingMs(phoneRate)));
        if (resolvedWabaId) delays.push(await reserveSlot(redis, `campaign:rate:waba:${resolvedWabaId}`, spacingMs(wabaRate)));
        const delayMs = Math.min(Math.max(...delays, 0), MAX_WAIT_MS);
        if (delayMs > 0) await sleep(delayMs);
    } catch (err) {
        logger.warn("Campaign rate limiter skipped", {
            workspaceId: String(workspaceId || ""),
            wabaId: String(wabaId || ""),
            message: err?.message || String(err),
        });
    }
}

module.exports = { waitForCampaignSendSlot, parseThroughputRate };
