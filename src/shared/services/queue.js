const { Queue } = require("bullmq");
const { createRedisConnection } = require("@infra/redis/redisClient");

let _connection;

function getRedisConnection() {
  if (_connection) return _connection;
  _connection = createRedisConnection();
  return _connection;
}

function createQueue(name) {
  return new Queue(name, { connection: getRedisConnection() });
}

module.exports = { getRedisConnection, createQueue };
