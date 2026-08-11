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
const MAX_LOCK_RECOVERY_REQUEUES = Math.max(Number(process.env.AI_RUNTIME_LOCK_RECOVERY_REQUEUES || 3), 1);

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
        if (isNonRetryableRuntimeError(error)) {
          throw new UnrecoverableError(error?.message || "AI runtime non-retryable failure");
        }
        if (isRetryableRuntimeError(error) && finalAttempt) {
          const lockContention =
            error?.code === "AI_CONVERSATION_LOCK_BUSY" ||
            error?.code === "AI_CONVERSATION_LOCK_LOST";
          const collisionRecoveryCount = Math.max(Number(job?.data?.collisionRecoveryCount || 0), 0);
          if (lockContention && collisionRecoveryCount < MAX_LOCK_RECOVERY_REQUEUES) {
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
                delay: LOCK_RECOVERY_DELAY_MS,
              }
            );
            return {
              success: true,
              requeued: true,
              reason: "lock_contention_recovery",
              recoveryCount,
            };
          }
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
