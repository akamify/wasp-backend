require("module-alias/register");
require("@core/config/loadEnv").loadEnv();
process.env.WORKER_PROCESS = "true";

const { connectDB } = require("@core/config/db");
const { mongoUri } = require("@core/config/env");
const {
    startAllWorkers,
    stopAllWorkers,
} = require("@infra/workers/index");
const { installProcessLifecycle } = require("@core/utils/processLifecycle");
const { closeRedisConnection } = require("@infra/redis/redisClient");

async function startWorker() {
    await connectDB(mongoUri);
    startAllWorkers();
}

installProcessLifecycle({
    name: "worker",
    shutdown: async () => {
        await stopAllWorkers();
        await closeRedisConnection();
    },
});

startWorker().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] startup failed", {
        message: err?.message || String(err),
        stack: err?.stack || null,
    });
    process.exit(1);
});
