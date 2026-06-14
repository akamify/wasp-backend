const mongoose = require("mongoose");
const { assignConversation } = require("@modules/crm/services/leadAssignment.service");
const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const {
  resolveVariables,
  normalizeTags,
  normalizeAttributes,
  sendText,
  writeEvent,
  moveSession,
} = require("@modules/flows/services/flowRuntime.utils");

async function executeSetTagNode({
  workspaceId,
  session,
  contact,
  node,
  scope,
  businessInitiated = false,
}) {
  const tags = normalizeTags(resolveVariables(node.config?.tags || [], scope));
  const action = node.config?.action === "remove" ? "remove" : "add";
  const updatedContact =
    action === "remove"
      ? await flowSessionRepository.removeContactTags({
          workspaceId,
          contactId: contact._id,
          tags,
        })
      : await flowSessionRepository.addContactTags({
          workspaceId,
          contactId: contact._id,
          tags,
        });
  contact.tags = updatedContact?.tags || contact.tags;
  await writeEvent({
    workspaceId,
    session,
    eventType: "tag_set",
    nodeId: node.id,
    data: { action, tags },
  });
}

async function executeSetAttributeNode({
  workspaceId,
  session,
  contact,
  node,
  scope,
}) {
  const attributes = normalizeAttributes(
    resolveVariables(node.config?.attributes || {}, scope)
  );
  if (Object.keys(attributes).length) {
    const updatedContact = await flowSessionRepository.mergeContactAttributes({
      workspaceId,
      contactId: contact._id,
      attributes,
    });
    contact.attributes = updatedContact?.attributes || contact.attributes;
  }
  await writeEvent({
    workspaceId,
    session,
    eventType: "attribute_set",
    nodeId: node.id,
    data: { attributes },
  });
}

async function requestHandover({
  workspaceId,
  session,
  contact,
  node,
  businessInitiated = false,
}) {
  const config = node.config || {};
  const message = config.message;
  if (String(message || "").trim()) {
    await sendText({
      workspaceId,
      contact,
      text: message,
      businessInitiated,
    });
  }

  const now = new Date();
  const handedOver = await moveSession({
    workspaceId,
    session,
    nodeId: node.id,
    updates: {
      status: "handover",
      completedAt: now,
      waitingFor: { type: null, attributeKey: null, nodeId: null },
    },
  });
  await flowSessionRepository.pauseConversationAutomation({
    workspaceId,
    wabaId: contact.wabaId,
    phone: contact.phone,
    sessionId: session._id,
    pausedAt: now,
  });

  const assignToTeamId = String(config.assignToTeamId || "").trim();
  let assignment = null;
  if (mongoose.Types.ObjectId.isValid(assignToTeamId)) {
    assignment = await assignConversation({
      workspaceId,
      wabaId: contact.wabaId,
      phone: contact.phone,
      toEmployeeId: assignToTeamId,
      mode: "FLOW_HANDOVER",
      reason: "Chat automation requested intervention",
      assignedBy: { kind: "system" },
    }).catch(() => ({ assigned: false, reason: "assignment_failed" }));
  }

  await writeEvent({
    workspaceId,
    session: handedOver,
    eventType: "handover_requested",
    nodeId: node.id,
    data: {
      assignToTeamId: assignToTeamId || null,
      assignment,
    },
  });
  return { status: "handover", session: handedOver };
}

module.exports = {
  executeSetTagNode,
  executeSetAttributeNode,
  requestHandover,
};
