const { randomUUID } = require("crypto");
const { Conversation } = require("@infra/database/Conversation");
const { createRedisConnection } = require("@infra/redis/redisClient");
const { isRedisDisabled } = require("@core/config/redis");

const REDIS_RELEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const REDIS_EXTEND_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

function buildConversationLockKey({ workspaceId, conversationId }) {
  return `ai:conversation-lock:${String(workspaceId)}:${String(conversationId)}`;
}

class AiConversationLockCollisionError extends Error {
  constructor(message = "AI conversation lock busy", details = {}) {
    super(message);
    this.name = "AiConversationLockCollisionError";
    this.code = "AI_CONVERSATION_LOCK_BUSY";
    this.retryable = true;
    this.details = details;
  }
}

function getRedisConnectionSafe() {
  if (isRedisDisabled()) return null;
  try {
    return createRedisConnection();
  } catch (_) {
    return null;
  }
}

async function loadCollisionDetails({ redis, redisKey, workspaceId, conversationId }) {
  const details = {
    workspaceId: String(workspaceId),
    conversationId: String(conversationId),
    lockTtlMs: null,
    lockUntil: null,
    messageId: null,
  };
  if (redis && redisKey) {
    try {
      const ttl = await redis.pttl(redisKey);
      if (Number.isFinite(ttl) && ttl >= 0) details.lockTtlMs = ttl;
    } catch (_) {
      // Ignore lock telemetry failures.
    }
  }
  try {
    const conversation = await Conversation.findOne({
      _id: conversationId,
      workspaceId,
    })
      .select("aiProcessingLockUntil aiProcessingMessageId")
      .lean();
    details.lockUntil = conversation?.aiProcessingLockUntil || null;
    details.messageId = conversation?.aiProcessingMessageId || null;
  } catch (_) {
    // Ignore lock telemetry failures.
  }
  return details;
}

async function acquireConversationLock({
  workspaceId,
  conversationId,
  messageId,
  executionKey = null,
  lockMs,
}) {
  const ownerToken = randomUUID();
  const now = new Date();
  const lockUntil = new Date(now.getTime() + lockMs);
  const redisKey = buildConversationLockKey({ workspaceId, conversationId });
  const redis = getRedisConnectionSafe();
  let redisAcquired = false;

  if (redis) {
    const acquired = await redis.set(redisKey, ownerToken, "PX", lockMs, "NX");
    if (acquired !== "OK") {
      const details = await loadCollisionDetails({ redis, redisKey, workspaceId, conversationId });
      throw new AiConversationLockCollisionError("AI conversation lock busy", details);
    }
    redisAcquired = true;
  }

  const conversation = await Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      workspaceId,
      $or: [
        { aiProcessingLockUntil: null },
        { aiProcessingLockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        aiProcessingLockUntil: lockUntil,
        aiProcessingMessageId: messageId || null,
        aiProcessingLockOwner: ownerToken,
      },
    },
    { returnDocument: "after" }
  );

  if (!conversation) {
    if (redisAcquired && redis) {
      try {
        await redis.eval(REDIS_RELEASE_SCRIPT, 1, redisKey, ownerToken);
      } catch (_) {
        // Ignore release cleanup failures here.
      }
    }
    const details = await loadCollisionDetails({ redis, redisKey, workspaceId, conversationId });
    throw new AiConversationLockCollisionError("AI conversation database lock busy", details);
  }

  return {
    workspaceId: String(workspaceId),
    conversationId: String(conversationId),
    messageId: messageId ? String(messageId) : null,
    executionKey: executionKey ? String(executionKey) : null,
    ownerToken,
    redis,
    redisKey,
    redisBacked: Boolean(redisAcquired),
    lockMs,
    lockUntil,
  };
}

async function extendConversationLock(lockHandle) {
  if (!lockHandle?.ownerToken) {
    return { extended: false, reason: "missing_owner_token" };
  }
  const nextLockUntil = new Date(Date.now() + Number(lockHandle.lockMs || 0));
  if (lockHandle.redisBacked && lockHandle.redis && lockHandle.redisKey) {
    const extended = await lockHandle.redis.eval(
      REDIS_EXTEND_SCRIPT,
      1,
      lockHandle.redisKey,
      lockHandle.ownerToken,
      String(lockHandle.lockMs)
    );
    if (Number(extended || 0) !== 1) {
      return { extended: false, reason: "redis_lock_lost" };
    }
  }

  const updated = await Conversation.updateOne(
    {
      _id: lockHandle.conversationId,
      workspaceId: lockHandle.workspaceId,
      aiProcessingLockOwner: lockHandle.ownerToken,
    },
    {
      $set: {
        aiProcessingLockUntil: nextLockUntil,
        aiProcessingMessageId: lockHandle.messageId || null,
      },
    }
  ).catch(() => ({ matchedCount: 0 }));

  if (!Number(updated?.matchedCount || 0)) {
    return { extended: false, reason: "db_lock_lost" };
  }

  lockHandle.lockUntil = nextLockUntil;
  return { extended: true, lockUntil: nextLockUntil };
}

async function releaseConversationLock(lockHandle) {
  if (!lockHandle?.ownerToken) return { released: false, reason: "missing_owner_token" };
  let redisReleased = null;
  if (lockHandle.redisBacked && lockHandle.redis && lockHandle.redisKey) {
    try {
      const released = await lockHandle.redis.eval(
        REDIS_RELEASE_SCRIPT,
        1,
        lockHandle.redisKey,
        lockHandle.ownerToken
      );
      redisReleased = Number(released || 0) === 1;
    } catch (_) {
      redisReleased = false;
    }
  }

  const updated = await Conversation.updateOne(
    {
      _id: lockHandle.conversationId,
      workspaceId: lockHandle.workspaceId,
      aiProcessingLockOwner: lockHandle.ownerToken,
    },
    {
      $set: {
        aiProcessingLockUntil: null,
        aiProcessingMessageId: null,
        aiProcessingLockOwner: null,
      },
    }
  ).catch(() => ({ matchedCount: 0 }));

  return {
    released: Boolean(Number(updated?.matchedCount || 0)),
    redisReleased,
  };
}

module.exports = {
  acquireConversationLock,
  extendConversationLock,
  releaseConversationLock,
  buildConversationLockKey,
  AiConversationLockCollisionError,
};
