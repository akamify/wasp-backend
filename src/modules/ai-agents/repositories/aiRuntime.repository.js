const { AiConversation } = require("@infra/database/AiConversation");
const { AiUsageLog } = require("@infra/database/AiUsageLog");
const { Contact } = require("@infra/database/Contact");

function findContactById({ workspaceId, contactId }) {
  if (!contactId) return null;
  return Contact.findOne({ _id: contactId, workspaceId }).lean();
}

function findOrCreateTestConversation({ workspaceId, agentId, contactId, now }) {
  return AiConversation.findOneAndUpdate(
    {
      workspaceId,
      agentId,
      contactId: contactId || null,
      channel: "test",
      status: "active",
      deletedAt: null,
    },
    {
      $setOnInsert: {
        workspaceId,
        agentId,
        contactId: contactId || null,
        channel: "test",
        status: "active",
        messages: [],
      },
      $set: { lastMessageAt: now },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
}

function appendMessages({ workspaceId, conversationId, messages, lastMessageAt }) {
  return AiConversation.findOneAndUpdate(
    { _id: conversationId, workspaceId, deletedAt: null },
    {
      $push: { messages: { $each: messages } },
      $set: { lastMessageAt },
    },
    { returnDocument: "after", runValidators: true },
  );
}

function compactConversation({ workspaceId, conversationId, summary, messages, summaryUpdatedAt }) {
  return AiConversation.findOneAndUpdate(
    { _id: conversationId, workspaceId, deletedAt: null },
    {
      $set: {
        summary,
        summaryUpdatedAt,
        messages,
      },
    },
    { returnDocument: "after", runValidators: true },
  );
}

function listConversations({ workspaceId, agentId, limit = 20 }) {
  return AiConversation.find({
    workspaceId,
    agentId,
    deletedAt: null,
  })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(limit)
    .lean();
}

function clearTestMemory({ workspaceId, agentId, contactId }) {
  return AiConversation.updateMany(
    {
      workspaceId,
      agentId,
      channel: "test",
      ...(contactId ? { contactId } : {}),
      deletedAt: null,
    },
    {
      $set: {
        status: "closed",
        deletedAt: new Date(),
      },
    },
  );
}

function createUsageLog(payload) {
  return AiUsageLog.create(payload);
}

module.exports = {
  findContactById,
  findOrCreateTestConversation,
  appendMessages,
  compactConversation,
  listConversations,
  clearTestMemory,
  createUsageLog,
};
