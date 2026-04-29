const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { getRedisUrl } = require("../config/redis");

let _connection;

function getRedisConnection() {
  if (_connection) return _connection;
  _connection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return _connection;
}

function createQueue(name) {
  return new Queue(name, { connection: getRedisConnection() });
}

module.exports = { getRedisConnection, createQueue };

