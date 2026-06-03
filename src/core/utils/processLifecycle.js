const mongoose = require("mongoose");
const logger = require("@core/logger/logger");

function installProcessLifecycle({
  name,
  shutdown,
  exitTimeoutMs = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 10_000),
}) {
  let shuttingDown = false;

  async function runShutdown(signal, err) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (err) {
      logger.error(`${name} fatal error`, {
        signal,
        message: err?.message || String(err),
        stack: err?.stack || null,
      });
    } else {
      logger.info(`${name} shutdown requested`, { signal });
    }

    const forceTimer = setTimeout(() => {
      logger.error(`${name} force exit timeout`, { signal, timeoutMs: exitTimeoutMs });
      process.exit(1);
    }, Math.max(exitTimeoutMs, 1000));

    try {
      await Promise.resolve(shutdown?.({ signal, error: err || null }));
    } catch (shutdownErr) {
      logger.error(`${name} shutdown failed`, {
        signal,
        message: shutdownErr?.message || String(shutdownErr),
      });
    } finally {
      clearTimeout(forceTimer);
      try {
        if (mongoose.connection?.readyState === 1 || mongoose.connection?.readyState === 2) {
          await mongoose.connection.close();
        }
      } catch (_) {}
      process.exit(err ? 1 : 0);
    }
  }

  process.on("unhandledRejection", (err) => runShutdown("unhandledRejection", err));
  process.on("uncaughtException", (err) => runShutdown("uncaughtException", err));
  process.on("SIGINT", () => runShutdown("SIGINT"));
  process.on("SIGTERM", () => runShutdown("SIGTERM"));
}

module.exports = { installProcessLifecycle };
