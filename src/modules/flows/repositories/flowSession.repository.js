const { Contact } = require("@infra/database/Contact");
const { FlowSession } = require("@infra/database/FlowSession");
const { FlowEvent } = require("@infra/database/FlowEvent");
const { FlowVersion } = require("@infra/database/FlowVersion");
const { Conversation } = require("@infra/database/Conversation");
const { Template } = require("@infra/database/Template");

async function findContactById({ workspaceId, contactId }) {
  return Contact.findOne({ _id: contactId, workspaceId });
}

async function findActiveSession({ workspaceId, contactId, now }) {
  return FlowSession.findOne({
    workspaceId,
    contactId,
    status: "active",
    expiresAt: { $gt: now },
  }).sort({ startedAt: -1 });
}

async function createSession(data) {
  return FlowSession.create(data);
}

async function createFlowStartedEvent(data) {
  return FlowEvent.create(data);
}

async function createFlowEvent(data) {
  return FlowEvent.create(data);
}

async function findSessionById({ workspaceId, sessionId }) {
  return FlowSession.findOne({ _id: sessionId, workspaceId });
}

async function findFlowVersionById({ workspaceId, flowVersionId }) {
  return FlowVersion.findOne({ _id: flowVersionId, workspaceId });
}

async function updateSession({ workspaceId, sessionId, updates }) {
  return FlowSession.findOneAndUpdate(
    { _id: sessionId, workspaceId },
    { $set: updates },
    { new: true, runValidators: true }
  );
}

async function incrementFallbackCount({ workspaceId, sessionId, now }) {
  return FlowSession.findOneAndUpdate(
    { _id: sessionId, workspaceId, status: "active" },
    {
      $inc: { fallbackCount: 1 },
      $set: { lastMessageAt: now },
    },
    { new: true, runValidators: true }
  );
}

async function addContactTags({ workspaceId, contactId, tags }) {
  return Contact.findOneAndUpdate(
    { _id: contactId, workspaceId },
    { $addToSet: { tags: { $each: tags } } },
    { new: true, runValidators: true }
  );
}

async function removeContactTags({ workspaceId, contactId, tags }) {
  return Contact.findOneAndUpdate(
    { _id: contactId, workspaceId },
    { $pull: { tags: { $in: tags } } },
    { new: true, runValidators: true }
  );
}

async function mergeContactAttributes({
  workspaceId,
  contactId,
  attributes,
}) {
  const updates = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      `attributes.${key}`,
      value,
    ])
  );
  return Contact.findOneAndUpdate(
    { _id: contactId, workspaceId },
    { $set: updates },
    { new: true, runValidators: true }
  );
}

async function pauseConversationAutomation({
  workspaceId,
  wabaId,
  phone,
  sessionId,
  pausedAt,
}) {
  return Conversation.findOneAndUpdate(
    { workspaceId, wabaId, phone },
    {
      $set: {
        automationPausedAt: pausedAt,
        automationPauseReason: "flow_handover",
        automationPausedByFlowSessionId: sessionId,
      },
    },
    { new: true, runValidators: true }
  );
}

async function findPausedConversation({ workspaceId, wabaId, phone }) {
  return Conversation.findOne({
    workspaceId,
    wabaId,
    phone,
    automationPausedAt: { $ne: null },
  })
    .select("_id automationPausedAt automationPauseReason")
    .lean();
}

async function findApprovedTemplate({
  workspaceId,
  wabaId,
  name,
  languageCode,
}) {
  return Template.findOne({
    workspaceId,
    wabaId,
    name,
    languageCode,
    status: "approved",
    isActive: { $ne: false },
    deletedAt: null,
  });
}

async function expireSession({ workspaceId, sessionId, completedAt }) {
  return FlowSession.findOneAndUpdate(
    { _id: sessionId, workspaceId, status: "active" },
    {
      $set: {
        status: "expired",
        completedAt,
        lockedUntil: null,
        lockedBy: null,
      },
    },
    { new: true, runValidators: true }
  );
}

async function deleteSession({ workspaceId, sessionId }) {
  return FlowSession.deleteOne({ _id: sessionId, workspaceId });
}

module.exports = {
  findContactById,
  findActiveSession,
  createSession,
  createFlowStartedEvent,
  createFlowEvent,
  findSessionById,
  findFlowVersionById,
  updateSession,
  incrementFallbackCount,
  addContactTags,
  removeContactTags,
  mergeContactAttributes,
  pauseConversationAutomation,
  findPausedConversation,
  findApprovedTemplate,
  expireSession,
  deleteSession,
};
