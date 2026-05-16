const { Queue, QueueEvents, Worker, QueueScheduler } = require("bullmq");
const { createRedisConnection } = require("@infra/redis/redisClient");

function buildQueueConnection() {
    return createRedisConnection();
}

function createQueue(name, options = {}) {
    return new Queue(name, {
        connection: buildQueueConnection(),
        defaultJobOptions: options.defaultJobOptions,
    });
}

function createQueueScheduler(name) {
    // BullMQ v5 removed/changed QueueScheduler export.
    // Keep backward compatibility by treating scheduler as optional.
    if (typeof QueueScheduler !== "function") return null;
    return new QueueScheduler(name, { connection: buildQueueConnection() });
}

function createQueueEvents(name) {
    return new QueueEvents(name, { connection: buildQueueConnection() });
}

function createWorker(name, processor, options = {}) {
    return new Worker(name, processor, { connection: buildQueueConnection(), ...options });
}

module.exports = {
    createQueue,
    createQueueScheduler,
    createQueueEvents,
    createWorker,
};
