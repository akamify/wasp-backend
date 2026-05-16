const DEFAULT_LEVELS = new Set(["debug", "info", "warn", "error"]);

function normalizeMeta(meta) {
    if (!meta || typeof meta !== "object") return {};
    return meta;
}

function emit(level, message, meta) {
    const payload = {
        ts: new Date().toISOString(),
        level,
        message: String(message || ""),
        ...normalizeMeta(meta),
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
        // eslint-disable-next-line no-console
        console.error(line);
        return;
    }
    if (level === "warn") {
        // eslint-disable-next-line no-console
        console.warn(line);
        return;
    }
    // eslint-disable-next-line no-console
    console.log(line);
}

function createLogger(baseMeta = {}) {
    const normalizedBase = normalizeMeta(baseMeta);
    const logger = {};
    for (const level of DEFAULT_LEVELS) {
        logger[level] = (message, meta) => emit(level, message, { ...normalizedBase, ...normalizeMeta(meta) });
    }
    logger.child = (childMeta) => createLogger({ ...normalizedBase, ...normalizeMeta(childMeta) });
    return logger;
}

const logger = createLogger({ service: "backend" });

module.exports = { logger, createLogger };
