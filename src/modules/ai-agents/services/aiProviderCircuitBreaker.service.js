const { createRedisConnection } = require("@infra/redis/redisClient");
const { isRedisDisabled } = require("@core/config/redis");
const {
  AiRuntimeRetryableError,
  isRetryableRuntimeError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");

const BREAKER_STATE_OPEN = "OPEN";
const BREAKER_STATE_HALF_OPEN = "HALF_OPEN";
const BREAKER_STATE_CLOSED = "CLOSED";

const FAILURE_THRESHOLD = Math.max(Number(process.env.AI_PROVIDER_BREAKER_FAILURE_THRESHOLD || 5), 1);
const COOLDOWN_MS = Math.max(Number(process.env.AI_PROVIDER_BREAKER_COOLDOWN_MS || 60000), 5000);
const STATE_TTL_MS = Math.max(Number(process.env.AI_PROVIDER_BREAKER_STATE_TTL_MS || COOLDOWN_MS * 10), COOLDOWN_MS);

const memoryStateStore = new Map();
const memoryProbeStore = new Map();

function stateKey({ workspaceId = "global", provider, model }) {
  return `ai:provider-breaker:${String(workspaceId || "global")}::${String(provider || "unknown")}::${String(model || "default")}`;
}

function probeKey({ workspaceId = "global", provider, model }) {
  return `${stateKey({ workspaceId, provider, model })}:probe`;
}

function stateTtlMs() {
  return STATE_TTL_MS;
}

function getRedisConnectionSafe() {
  if (isRedisDisabled()) return null;
  try {
    return createRedisConnection();
  } catch (_) {
    return null;
  }
}

function pruneMemoryEntry(store, key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

async function readState(redis, key) {
  if (redis) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = pruneMemoryEntry(memoryStateStore, key);
  return entry ? entry.value : null;
}

async function writeState(redis, key, value, ttlMs = stateTtlMs()) {
  if (redis) {
    await redis.psetex(key, ttlMs, JSON.stringify(value));
    return;
  }
  memoryStateStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

async function clearState(redis, key) {
  if (redis) {
    await redis.del(key);
    return;
  }
  memoryStateStore.delete(key);
}

async function acquireProbe(redis, key, ttlMs = COOLDOWN_MS) {
  if (redis) {
    const result = await redis.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK";
  }
  const active = pruneMemoryEntry(memoryProbeStore, key);
  if (active) return false;
  memoryProbeStore.set(key, {
    value: "1",
    expiresAt: Date.now() + ttlMs,
  });
  return true;
}

async function releaseProbe(redis, key) {
  if (redis) {
    await redis.del(key);
    return;
  }
  memoryProbeStore.delete(key);
}

function buildOpenError({ workspaceId = "global", provider, model, state }) {
  return new AiRuntimeRetryableError("AI provider circuit breaker is temporarily open", {
    code: "AI_PROVIDER_CIRCUIT_OPEN",
    statusCode: 503,
    category: "provider",
    reason: "provider_circuit_open",
    details: {
      workspaceId: String(workspaceId || "global"),
      provider,
      model,
      state: state?.status || BREAKER_STATE_OPEN,
      consecutiveFailures: Number(state?.consecutiveFailures || 0),
      cooldownMs: Number(state?.cooldownMs || COOLDOWN_MS),
      openedAt: state?.openedAt || null,
      lastFailureAt: state?.lastFailureAt || null,
    },
  });
}

async function beforeProviderRequest({ workspaceId = "global", provider = "gemini", model = "default" }) {
  const redis = getRedisConnectionSafe();
  const key = stateKey({ workspaceId, provider, model });
  const gateKey = probeKey({ workspaceId, provider, model });
  const now = Date.now();
  const state = await readState(redis, key);
  if (!state || state.status === BREAKER_STATE_CLOSED) {
    return {
      allowed: true,
      status: BREAKER_STATE_CLOSED,
      provider,
      model,
    };
  }

  const openedAt = Number(state.openedAt || 0);
  const cooldownMs = Math.max(Number(state.cooldownMs || COOLDOWN_MS), 1000);
  const cooldownElapsed = openedAt > 0 && now - openedAt >= cooldownMs;

  if (state.status === BREAKER_STATE_HALF_OPEN) {
    throw buildOpenError({ workspaceId, provider, model, state });
  }

  if (!cooldownElapsed) {
    throw buildOpenError({ workspaceId, provider, model, state });
  }

  const probeAcquired = await acquireProbe(redis, gateKey, cooldownMs);
  if (!probeAcquired) {
    throw buildOpenError({
      workspaceId,
      provider,
      model,
      state: {
        ...state,
        status: BREAKER_STATE_HALF_OPEN,
      },
    });
  }

  const nextState = {
    provider,
    model,
    status: BREAKER_STATE_HALF_OPEN,
    consecutiveFailures: Number(state.consecutiveFailures || 0),
    failureThreshold: Number(state.failureThreshold || FAILURE_THRESHOLD),
    cooldownMs,
    openedAt,
    lastFailureAt: state.lastFailureAt || null,
    halfOpenAt: now,
    lastSuccessAt: state.lastSuccessAt || null,
    updatedAt: now,
  };
  await writeState(redis, key, nextState);
  return {
    allowed: true,
    status: BREAKER_STATE_HALF_OPEN,
    provider,
    model,
  };
}

async function recordProviderSuccess({ workspaceId = "global", provider = "gemini", model = "default" }) {
  const redis = getRedisConnectionSafe();
  const key = stateKey({ workspaceId, provider, model });
  const gateKey = probeKey({ workspaceId, provider, model });
  const now = Date.now();
  await releaseProbe(redis, gateKey).catch(() => {});
  await writeState(redis, key, {
    provider,
    model,
    status: BREAKER_STATE_CLOSED,
    consecutiveFailures: 0,
    failureThreshold: FAILURE_THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    openedAt: null,
    halfOpenAt: null,
    lastFailureAt: null,
    lastSuccessAt: now,
    updatedAt: now,
  });
}

async function recordProviderFailure({ workspaceId = "global", provider = "gemini", model = "default", error }) {
  if (!isRetryableRuntimeError(error)) return null;
  const redis = getRedisConnectionSafe();
  const key = stateKey({ workspaceId, provider, model });
  const gateKey = probeKey({ workspaceId, provider, model });
  const now = Date.now();
  const existing = await readState(redis, key);
  const currentFailures = Number(existing?.consecutiveFailures || 0);
  const threshold = Math.max(Number(existing?.failureThreshold || FAILURE_THRESHOLD), 1);
  const nextFailures = existing?.status === BREAKER_STATE_HALF_OPEN ? threshold : currentFailures + 1;
  const shouldOpen = nextFailures >= threshold;
  const nextState = {
    provider,
    model,
    status: shouldOpen ? BREAKER_STATE_OPEN : BREAKER_STATE_CLOSED,
    consecutiveFailures: nextFailures,
    failureThreshold: threshold,
    cooldownMs: Math.max(Number(existing?.cooldownMs || COOLDOWN_MS), 1000),
    openedAt: shouldOpen ? now : existing?.openedAt || null,
    halfOpenAt: null,
    lastFailureAt: now,
    lastSuccessAt: existing?.lastSuccessAt || null,
    updatedAt: now,
  };
  await writeState(redis, key, nextState);
  if (shouldOpen) {
    await releaseProbe(redis, gateKey).catch(() => {});
  }
  return nextState;
}

module.exports = {
  beforeProviderRequest,
  recordProviderSuccess,
  recordProviderFailure,
  BREAKER_STATE_OPEN,
  BREAKER_STATE_HALF_OPEN,
  BREAKER_STATE_CLOSED,
};
