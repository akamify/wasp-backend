const aiRuntimeRepository = require("@modules/ai-agents/repositories/aiRuntime.repository");

const MAX_CONTEXT_MESSAGES = 12;
const MAX_STORED_MESSAGES_BEFORE_SUMMARY = 40;
const SUMMARY_KEEP_MESSAGES = 20;
const MAX_SUMMARY_CHARS = 6000;

function serializeConversation(conversation) {
  if (!conversation) return null;
  const value = typeof conversation.toObject === "function" ? conversation.toObject() : conversation;
  return {
    ...value,
    id: String(value._id),
    _id: String(value._id),
    workspaceId: String(value.workspaceId),
    agentId: String(value.agentId),
    contactId: value.contactId ? String(value.contactId) : null,
  };
}

function recentMessages(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return messages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role,
      text: String(message.text || ""),
    }))
    .filter((message) => message.text.trim());
}

function conversationSummary(conversation) {
  return String(conversation?.summary || "").trim();
}

function summarizeMessages(messages, previousSummary = "") {
  const olderText = (messages || [])
    .map((message) => {
      const role = String(message.role || "message").toUpperCase();
      const text = String(message.text || "").replace(/\s+/g, " ").trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const combined = [
    previousSummary ? `Previous summary:\n${previousSummary}` : "",
    olderText ? `Important earlier conversation:\n${olderText}` : "",
  ].filter(Boolean).join("\n\n");
  if (combined.length <= MAX_SUMMARY_CHARS) return combined;
  return combined.slice(combined.length - MAX_SUMMARY_CHARS);
}

async function compactIfNeeded({ workspaceId, conversation }) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  if (messages.length <= MAX_STORED_MESSAGES_BEFORE_SUMMARY) return conversation;
  const keepMessages = messages.slice(-SUMMARY_KEEP_MESSAGES);
  const olderMessages = messages.slice(0, -SUMMARY_KEEP_MESSAGES);
  const summary = summarizeMessages(olderMessages, conversation.summary);
  return aiRuntimeRepository.compactConversation({
    workspaceId,
    conversationId: conversation._id,
    summary,
    messages: keepMessages,
    summaryUpdatedAt: new Date(),
  });
}

async function getTestConversation({ workspaceId, agentId, contactId }) {
  return aiRuntimeRepository.findOrCreateTestConversation({
    workspaceId,
    agentId,
    contactId: contactId || null,
    now: new Date(),
  });
}

async function appendExchange({ workspaceId, conversation, userMessage, assistantMessage, metadata }) {
  const now = new Date();
  const updatedConversation = await aiRuntimeRepository.appendMessages({
    workspaceId,
    conversationId: conversation._id,
    lastMessageAt: now,
    messages: [
      {
        role: "user",
        text: userMessage,
        metadata: metadata?.user || {},
        createdAt: now,
      },
      {
        role: "assistant",
        text: assistantMessage,
        metadata: metadata?.assistant || {},
        createdAt: now,
      },
    ],
  });
  return compactIfNeeded({ workspaceId, conversation: updatedConversation });
}

async function listConversations({ workspaceId, agentId }) {
  const conversations = await aiRuntimeRepository.listConversations({
    workspaceId,
    agentId,
    limit: 25,
  });
  return conversations.map(serializeConversation);
}

async function clearTestMemory({ workspaceId, agentId, contactId }) {
  await aiRuntimeRepository.clearTestMemory({ workspaceId, agentId, contactId });
  return { success: true };
}

module.exports = {
  getTestConversation,
  recentMessages,
  conversationSummary,
  appendExchange,
  listConversations,
  clearTestMemory,
  serializeConversation,
};
