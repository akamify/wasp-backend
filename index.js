require("module-alias/register");
require("@core/config/loadEnv").loadEnv();

const http = require("http");
const app = require("./app");
const { createSocketServer } = require("@infra/websocket/socketServer");
const { connectDB } = require("@core/config/db");
const { port, mongoUri } = require("@core/config/env");
const { installProcessLifecycle } = require("@core/utils/processLifecycle");
const { closeRedisConnection } = require("@infra/redis/redisClient");

let httpServer = null;

async function start() {
  await connectDB(mongoUri);
  httpServer = http.createServer(app);
  createSocketServer(httpServer);
  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on port ${port}`);
  });
}

installProcessLifecycle({
  name: "api-server",
  shutdown: async () => {
    await new Promise((resolve) => {
      if (!httpServer) return resolve();
      httpServer.close(() => resolve());
    });
    await closeRedisConnection();
  },
});

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});

