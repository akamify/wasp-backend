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

startWorker().catch(() => {
    process.exit(1);
});
const __consoleNoop = () => {};
console.log = __consoleNoop;
console.info = __consoleNoop;
console.warn = __consoleNoop;
console.error = __consoleNoop;
console.debug = __consoleNoop;
