const { sendTextMessageForUser } = require("@shared/services/outboundMessageService");
const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const {
  assertFreeformSendAllowed,
} = require("@shared/services/whatsappCustomerWindow");

function asPlainAttributes(attributes) {
  if (!attributes) return {};
  if (attributes instanceof Map) return Object.fromEntries(attributes.entries());
  if (typeof attributes === "object" && !Array.isArray(attributes)) {
    return { ...attributes };
  }
  return {};
}

function getPath(source, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value?.[key], source);
}

function logMissingVariable(path, scope) {
  const meta = scope?.__meta || {};
  process.stdout.write(
    `[FLOW_VARIABLE_MISSING] ${JSON.stringify({
      variable: String(path || ""),
      nodeId: meta.nodeId || null,
      flowId: meta.flowId || null,
      sessionId: meta.sessionId || null,
    })}\n`
  );
}

function resolveValue(value, scope) {
  if (typeof value !== "string") return value;
  const exact = value.match(/^\s*\{\{\s*([^}]+)\s*\}\}\s*$/);
  if (exact) {
    const resolved = getPath(scope, exact[1].trim());
    if (resolved == null) logMissingVariable(exact[1].trim(), scope);
    return resolved == null ? "" : resolved;
  }
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => {
    const resolved = getPath(scope, path.trim());
    if (resolved == null) logMissingVariable(path.trim(), scope);
    return resolved == null ? "" : String(resolved);
  });
}

function resolveVariables(value, scope) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveVariables(item, scope));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveVariables(item, scope),
      ])
    );
  }
  return resolveValue(value, scope);
}

function normalizeTags(tags) {
  return Array.from(
    new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))
  );
}

function normalizeAttributes(attributes) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(attributes)
      .map(([rawKey, value]) => [String(rawKey || "").trim(), value])
      .filter(
        ([key, value]) =>
          key &&
          !key.includes(".") &&
          !key.startsWith("$") &&
          value !== null &&
          value !== undefined &&
          !(typeof value === "string" && value.trim() === "")
      )
  );
}

function defaultEdge(version, nodeId) {
  const outgoing = (version.edges || []).filter(
    (edge) => String(edge?.source || "") === String(nodeId)
  );
  return (
    outgoing.find((edge) =>
      ["", "default"].includes(
        String(edge?.sourceHandle || "").trim().toLowerCase()
      )
    ) || (outgoing.length === 1 ? outgoing[0] : null)
  );
}

function edgeForHandle(version, nodeId, handle) {
  return (version.edges || []).find(
    (edge) =>
      String(edge?.source || "") === String(nodeId) &&
      String(edge?.sourceHandle || "").trim() === String(handle || "").trim()
  );
}

function nodeById(version, nodeId) {
  return (version.nodes || []).find(
    (node) => String(node?.id || "") === String(nodeId || "")
  );
}

function buildScope(session, contact, inboundMessage, dependencies = {}) {
  const attributes = asPlainAttributes(contact.attributes);
  return {
    context: session.context || {},
    static: dependencies.static || dependencies.flow?.staticValues || {},
    attributes,
    contact: {
      id: String(contact._id),
      phone: contact.phone,
      name: contact.name || "",
      email: contact.email || "",
      company: contact.company || "",
      tags: contact.tags || [],
      attributes,
    },
    workspace: {
      id: String(dependencies.workspace?._id || session.workspaceId || ""),
      name:
        dependencies.workspace?.businessName ||
        dependencies.workspace?.name ||
        "",
    },
    flow: {
      id: String(dependencies.flow?._id || session.flowId || ""),
      name: dependencies.flow?.name || "",
    },
    inbound: {
      text: inboundMessage?.text || "",
      buttonReply: inboundMessage?.buttonReply || null,
      listReply: inboundMessage?.listReply || null,
    },
    __meta: {
      sessionId: String(session._id || ""),
      flowId: String(dependencies.flow?._id || session.flowId || ""),
      nodeId: dependencies.node?.id || null,
    },
  };
}

async function sendText({
  workspaceId,
  contact,
  session = null,
  node = null,
  text,
  businessInitiated = false,
  inboundMessage = null,
}) {
  const normalized = String(text || "").trim();
  if (!normalized) return;
  assertFreeformSendAllowed({
    contact,
    sendType: "text",
    businessInitiated,
  });
  await sendTextMessageForUser({
    userId: workspaceId,
    contactId: contact._id,
    to: contact.phone,
    text: normalized,
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
    flowSessionId: session?._id || null,
    flowId: session?.flowId || null,
    nodeId: node?.id || null,
  });
}

async function writeEvent({
  workspaceId,
  session,
  eventType,
  nodeId,
  data,
}) {
  await flowSessionRepository.createFlowEvent({
    workspaceId,
    flowId: session.flowId,
    flowVersionId: session.flowVersionId,
    sessionId: session._id,
    contactId: session.contactId,
    eventType,
    nodeId,
    data: data || null,
  });
}

async function moveSession({ workspaceId, session, nodeId, updates = {} }) {
  return flowSessionRepository.updateSession({
    workspaceId,
    sessionId: session._id,
    updates: {
      currentNodeId: nodeId,
      lastMessageAt: new Date(),
      ...updates,
    },
  });
}

module.exports = {
  resolveVariables,
  normalizeTags,
  normalizeAttributes,
  defaultEdge,
  edgeForHandle,
  nodeById,
  buildScope,
  sendText,
  writeEvent,
  moveSession,
};
