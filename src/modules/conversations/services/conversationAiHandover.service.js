const { Conversation } = require("@infra/database/Conversation");
const { writeConversationEvent } = require("@modules/crm/services/conversationEvent.service");
const { publishWorkspaceEvent, publishToWorkspace } = require("@shared/services/realtimeService");
const { HttpError } = require("@shared/utils/httpError");
const {
  AI_STATES,
  normalizeAiState,
} = require("@modules/ai-agents/constants/aiRuntime.constants");

function actorFromRequest(req) {
  return {
    kind: req.auth?.isApiKey ? "api" : (req.user?.role === "admin" ? "admin" : "owner"),
    actorId: req.user?.id || undefined,
    nameSnapshot: String(req.user?.name || req.user?.email || "").trim(),
  };
}

async function notifyConversationUpdate(workspaceId, conversation) {
  const payload = typeof conversation?.toObject === "function" ? conversation.toObject() : conversation;
  if (!payload?._id) return;
  publishToWorkspace(workspaceId, "conversation:update", { conversation: payload });
  publishWorkspaceEvent(workspaceId, {
    type: "conversation.updated",
    conversationId: String(payload._id),
    phone: payload.phone,
  });
}

async function takeOverConversation({
  workspaceId,
  wabaId,
  phone,
  actor,
  reason,
}) {
  const conversation = await Conversation.findOne({ workspaceId, wabaId, phone });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const now = new Date();
  const previousState = normalizeAiState(conversation.aiState, { fallback: null });
  const nextReason = String(reason || conversation.aiHandoverReason || "manual_takeover").trim().slice(0, 300);
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id, workspaceId },
    {
      $set: {
        aiState: AI_STATES.HUMAN_ACTIVE,
        aiHandoverAt: conversation.aiHandoverAt || now,
        aiHandoverReason: nextReason || "manual_takeover",
        aiEscalatedAt: conversation.aiEscalatedAt || now,
        aiEscalationLevel: Math.max(1, Number(conversation.aiEscalationLevel || 0)),
        aiEscalationReason: nextReason || conversation.aiEscalationReason || "manual_takeover",
      },
    },
    { returnDocument: "after" }
  );

  await writeConversationEvent({
    workspaceId,
    conversationId: conversation._id,
    phone,
    type: "ai_handover_taken_over",
    actor,
    payload: {
      previousState: previousState || null,
      nextState: AI_STATES.HUMAN_ACTIVE,
      reason: nextReason || "manual_takeover",
      aiAgentId: conversation.aiAgentId ? String(conversation.aiAgentId) : null,
      aiConversationId: conversation.aiConversationId ? String(conversation.aiConversationId) : null,
    },
  }).catch(() => {});

  await notifyConversationUpdate(workspaceId, updated);
  return updated;
}

async function returnConversationToAi({
  workspaceId,
  wabaId,
  phone,
  actor,
  reason,
}) {
  const conversation = await Conversation.findOne({ workspaceId, wabaId, phone });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const now = new Date();
  const previousState = normalizeAiState(conversation.aiState, { fallback: null });
  const nextReason = String(reason || "").trim().slice(0, 300);
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id, workspaceId },
    {
      $set: {
        aiState: AI_STATES.AI_ACTIVE,
        aiLastReplyAt: conversation.aiLastReplyAt || now,
        aiHandoverReason: nextReason || null,
        aiSlaDueAt: null,
        aiEscalatedAt: null,
        aiEscalationLevel: 0,
        aiEscalationReason: null,
      },
      $unset: {
        aiHandoverAt: 1,
      },
    },
    { returnDocument: "after" }
  );

  await writeConversationEvent({
    workspaceId,
    conversationId: conversation._id,
    phone,
    type: "ai_returned",
    actor,
    payload: {
      previousState: previousState || null,
      nextState: AI_STATES.AI_ACTIVE,
      reason: nextReason || null,
      aiAgentId: conversation.aiAgentId ? String(conversation.aiAgentId) : null,
      aiConversationId: conversation.aiConversationId ? String(conversation.aiConversationId) : null,
    },
  }).catch(() => {});

  await notifyConversationUpdate(workspaceId, updated);
  return updated;
}

module.exports = {
  actorFromRequest,
  takeOverConversation,
  returnConversationToAi,
};
