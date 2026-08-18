const { UnrecoverableError } = require("bullmq");
const { createWorker } = require("@infra/queues/queueFactory");
const { getAiRuntimeQueue } = require("@infra/queues/aiRuntime.queue");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");
const aiLiveRuntimeService = require("@modules/ai-agents/services/aiLiveRuntime.service");
const {
  isRetryableRuntimeError,
  isNonRetryableRuntimeError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");

const LOCK_RECOVERY_DELAY_MS = Math.max(Number(process.env.AI_RUNTIME_LOCK_RECOVERY_DELAY_MS || 5000), 1000);
const LOCK_RECOVERY_BUFFER_MS = Math.max(Number(process.env.AI_RUNTIME_LOCK_RECOVERY_BUFFER_MS || 1500), 250);
const MAX_LOCK_RECOVERY_REQUEUES = Math.max(Number(process.env.AI_RUNTIME_LOCK_RECOVERY_REQUEUES || 5), 1);

function isLockContentionError(error) {
  return (
    error?.code === "AI_CONVERSATION_LOCK_BUSY" ||
    error?.code === "AI_CONVERSATION_LOCK_LOST"
  );
}

function computeLockRecoveryDelay(error, collisionRecoveryCount) {
  const recoveryCount = collisionRecoveryCount + 1;
  const fallbackDelay = LOCK_RECOVERY_DELAY_MS * recoveryCount;
  const ttlDelay = Number(error?.details?.lockTtlMs || 0);
  if (Number.isFinite(ttlDelay) && ttlDelay > 0) {
    return Math.max(ttlDelay + LOCK_RECOVERY_BUFFER_MS, fallbackDelay);
  }
  const lockUntilRaw = error?.details?.lockUntil;
  const lockUntilMs = lockUntilRaw ? new Date(lockUntilRaw).getTime() : 0;
  if (Number.isFinite(lockUntilMs) && lockUntilMs > Date.now()) {
    return Math.max(lockUntilMs - Date.now() + LOCK_RECOVERY_BUFFER_MS, fallbackDelay);
  }
  return fallbackDelay;
}

async function requeueLockContentionJobWithDelay(job, collisionRecoveryCount, delay) {
  const queue = getAiRuntimeQueue();
  const recoveryCount = collisionRecoveryCount + 1;
  const recoveryExecutionKey =
    String(job?.data?.executionKey || "").trim() ||
    String(job?.data?.messageId || "").trim() ||
    String(job?.id || "").trim();
  await queue.add(
    "ai-runtime.process-inbound",
    {
      ...(job.data || {}),
      collisionRecoveryCount: recoveryCount,
    },
    {
      jobId: `ai-live-recovery:${recoveryExecutionKey}:${recoveryCount}`,
      delay,
    }
  );
  console.info("[ai-runtime-worker] lock contention requeued", {
    jobId: String(job?.id || ""),
    workspaceId: job?.data?.workspaceId || null,
    conversationId: job?.data?.conversationId || null,
    messageId: job?.data?.messageId || null,
    executionKey: job?.data?.executionKey || null,
    recoveryCount,
    delay,
  });
  return {
    success: true,
    requeued: true,
    reason: "lock_contention_recovery",
    recoveryCount,
    delay,
  };
}

function startAiRuntimeWorker() {
  return createWorker(
    QUEUE_NAMES.AI_RUNTIME,
    async (job) => {
      const name = String(job?.name || "");
      if (name !== "ai-runtime.process-inbound") return null;
      try {
        const result = await aiLiveRuntimeService.processInboundJob(job.data || {});
        if (result?.skipped || result?.requeued || result?.action) {
          console.info("[ai-runtime-worker] job settled", {
            jobId: String(job?.id || ""),
            workspaceId: job?.data?.workspaceId || null,
            conversationId: job?.data?.conversationId || null,
            messageId: job?.data?.messageId || null,
            executionKey: job?.data?.executionKey || null,
            skipped: result?.skipped || null,
            action: result?.action || null,
            requeued: Boolean(result?.requeued),
          });
        }
        return result;
      } catch (error) {
        console.error("[ai-runtime-worker] job failed", {
          jobId: String(job?.id || ""),
          workspaceId: job?.data?.workspaceId || null,
          conversationId: job?.data?.conversationId || null,
          messageId: job?.data?.messageId || null,
          executionKey: job?.data?.executionKey || null,
          code: error?.code || null,
          message: error?.message || String(error),
        });
        const maxAttempts = Math.max(Number(job?.opts?.attempts || 1), 1);
        const currentAttempt = Math.max(Number(job?.attemptsMade || 0) + 1, 1);
        const finalAttempt = currentAttempt >= maxAttempts;
        const collisionRecoveryCount = Math.max(Number(job?.data?.collisionRecoveryCount || 0), 0);
        if (isLockContentionError(error) && collisionRecoveryCount < MAX_LOCK_RECOVERY_REQUEUES) {
          const delay = computeLockRecoveryDelay(error, collisionRecoveryCount);
          return requeueLockContentionJobWithDelay(job, collisionRecoveryCount, delay);
        }
        const providerRateLimited =
          error?.code === "AI_PROVIDER_RATE_LIMITED" ||
          error?.reason === "provider_rate_limited";
        if (providerRateLimited) {
          return aiLiveRuntimeService.handleRetryExhaustedJob({
            ...(job.data || {}),
            error,
            attemptsMade: currentAttempt,
            maxAttempts,
          });
        }
        if (isNonRetryableRuntimeError(error)) {
          throw new UnrecoverableError(error?.message || "AI runtime non-retryable failure");
        }
        if (isRetryableRuntimeError(error) && finalAttempt) {
          return aiLiveRuntimeService.handleRetryExhaustedJob({
            ...(job.data || {}),
            error,
            attemptsMade: currentAttempt,
            maxAttempts,
          });
        }
        throw error;
      }
    },
    {
      concurrency: Math.max(Number(process.env.AI_RUNTIME_WORKER_CONCURRENCY || 3), 1),
    }
  );
}

module.exports = { startAiRuntimeWorker };
