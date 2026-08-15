const { AiConversation } = require("@infra/database/AiConversation");
const { AiUsageLog } = require("@infra/database/AiUsageLog");
const { Contact } = require("@infra/database/Contact");

function flattenObjectToDotted(prefix, value, target) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    target[prefix] = value;
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nextPrefix = `${prefix}.${key}`;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      flattenObjectToDotted(nextPrefix, nested, target);
      continue;
    }
    target[nextPrefix] = nested;
  }
}

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

function updateConversationMetadata({ workspaceId, conversationId, metadataPatch = {} }) {
  const flattened = {};
  for (const [key, value] of Object.entries(metadataPatch || {})) {
    flattenObjectToDotted(`metadata.${key}`, value, flattened);
  }
  return AiConversation.findOneAndUpdate(
    { _id: conversationId, workspaceId, deletedAt: null },
    { $set: flattened },
    { returnDocument: "after", runValidators: true }
  );
}

function updateContactAiMemory({ workspaceId, contactId, profile = {} }) {
  if (!contactId) return null;
  return Contact.findOneAndUpdate(
    { _id: contactId, workspaceId },
    {
      $set: {
        "attributes.ai_memory_profile": profile,
        ...(profile?.preferredLanguageStyle ? { language: profile.preferredLanguageStyle } : {}),
      },
    },
    { returnDocument: "after", runValidators: true }
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

function createUsageLog(payload, options = {}) {
  const executionKey = String(payload?.executionKey || "").trim();
  if (!executionKey) return AiUsageLog.create(payload);
  const mergeFields = options?.mergeOnExisting && options?.mergeFields && typeof options.mergeFields === "object"
    ? options.mergeFields
    : null;
  const setOnInsert = { ...payload };
  let setFields = mergeFields ? { ...mergeFields } : null;

  if (setFields) {
    const hasMetadataDotMerge = Object.keys(setFields).some((key) => key.startsWith("metadata."));
    if (hasMetadataDotMerge && setOnInsert.metadata && typeof setOnInsert.metadata === "object" && !Array.isArray(setOnInsert.metadata)) {
      delete setOnInsert.metadata;
      flattenObjectToDotted("metadata", payload.metadata, setOnInsert);
    }
  }

  return AiUsageLog.findOneAndUpdate(
    { workspaceId: payload.workspaceId, executionKey },
    {
      $setOnInsert: setOnInsert,
      ...(setFields ? { $set: setFields } : {}),
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    }
  );
}

module.exports = {
  findContactById,
  findOrCreateTestConversation,
  appendMessages,
  compactConversation,
  updateConversationMetadata,
  updateContactAiMemory,
  listConversations,
  clearTestMemory,
  createUsageLog,
};
