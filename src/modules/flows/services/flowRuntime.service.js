const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const {
  resolveVariables,
  defaultEdge,
  edgeForHandle,
  nodeById,
  buildScope,
  sendText,
  writeEvent,
  moveSession,
} = require("@modules/flows/services/flowRuntime.utils");
const {
  executeSetTagNode,
  executeSetAttributeNode,
  requestHandover,
} = require("@modules/flows/services/flowActionNodes.service");
const {
  sendListNode,
  sendMediaNode,
  sendTemplateNode,
} = require("@modules/flows/services/flowMessageNodes.service");
const {
  executeApiRequestNode,
} = require("@modules/flows/services/flowApiRequest.service");

const MAX_AUTO_STEPS = 50;
const MAX_FALLBACKS = 3;
const GENERIC_RETRY_MESSAGE = "Sorry, I could not understand that. Please try again.";
const GENERIC_END_MESSAGE =
  "Sorry, I could not complete this automation. A team member can assist you.";

async function executeSession({
  workspaceId,
  sessionId,
  inboundMessage = null,
}) {
  let session = await flowSessionRepository.findSessionById({
    workspaceId,
    sessionId,
  });
  if (!session || session.status !== "active") {
    return { status: session?.status || "session_not_active", session };
  }

  const [version, contact] = await Promise.all([
    flowSessionRepository.findFlowVersionById({
      workspaceId,
      flowVersionId: session.flowVersionId,
    }),
    flowSessionRepository.findContactById({
      workspaceId,
      contactId: session.contactId,
    }),
  ]);
  if (!version || !contact) {
    session = await moveSession({
      workspaceId,
      session,
      nodeId: session.currentNodeId,
      updates: {
        status: "failed",
        completedAt: new Date(),
        error: { message: "Flow runtime dependencies not found" },
      },
    });
    return { status: "failed", session };
  }

  for (let step = 0; step < MAX_AUTO_STEPS; step += 1) {
    const node = nodeById(version, session.currentNodeId);
    if (!node) {
      session = await moveSession({
        workspaceId,
        session,
        nodeId: session.currentNodeId,
        updates: {
          status: "failed",
          completedAt: new Date(),
          error: { message: "Current flow node not found" },
        },
      });
      return { status: "failed", session };
    }

    const scope = buildScope(session, contact, inboundMessage);
    if (node.type === "start") {
      const edge = defaultEdge(version, node.id);
      if (!edge) return failSession({ workspaceId, session, contact });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: edge.target,
      });
      continue;
    }

    if (node.type === "text") {
      await sendText({
        workspaceId,
        contact,
        text: resolveVariables(node.config?.text, scope),
      });
      const edge = defaultEdge(version, node.id);
      if (!edge) return completeSession({ workspaceId, session, node });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: edge.target,
      });
      continue;
    }

    if (node.type === "text_buttons") {
      await sendText({
        workspaceId,
        contact,
        text: resolveVariables(node.config?.text, scope),
      });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: node.id,
        updates: {
          waitingFor: {
            type: "button_reply",
            attributeKey: null,
            nodeId: node.id,
          },
        },
      });
      return { status: "waiting", session };
    }

    if (node.type === "ask_question") {
      await sendText({
        workspaceId,
        contact,
        text: resolveVariables(node.config?.question, scope),
      });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: node.id,
        updates: {
          waitingFor: {
            type: node.config?.inputType || "text",
            attributeKey: node.config?.saveToAttribute || null,
            nodeId: node.id,
          },
        },
      });
      return { status: "waiting", session };
    }

    if (node.type === "list") {
      await sendListNode({ workspaceId, contact, node, scope });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: node.id,
        updates: {
          waitingFor: {
            type: "list_reply",
            attributeKey: null,
            nodeId: node.id,
          },
        },
      });
      return { status: "waiting", session };
    }

    if (node.type === "media") {
      await sendMediaNode({ workspaceId, contact, node, scope });
      const edge = defaultEdge(version, node.id);
      if (node.config?.autoContinue === true && edge) {
        session = await moveSession({
          workspaceId,
          session,
          nodeId: edge.target,
        });
        continue;
      }
      return completeSession({ workspaceId, session, node });
    }

    if (node.type === "template") {
      await sendTemplateNode({ workspaceId, contact, node, scope });
      const edge = defaultEdge(version, node.id);
      if (node.config?.autoContinue === true && edge) {
        session = await moveSession({
          workspaceId,
          session,
          nodeId: edge.target,
        });
        continue;
      }
      return completeSession({ workspaceId, session, node });
    }

    if (node.type === "api_request") {
      const result = await executeApiRequestNode({
        workspaceId,
        session,
        node,
        scope,
      });
      const edge = edgeForHandle(
        version,
        node.id,
        result.success ? "success" : "failure"
      );
      if (!edge) {
        session = await moveSession({
          workspaceId,
          session,
          nodeId: node.id,
          updates: {
            context: result.context,
            status: "failed",
            completedAt: new Date(),
            error: result.error || {
              message: "API request node has no matching outcome edge",
            },
          },
        });
        return { status: "failed", session };
      }
      session = await moveSession({
        workspaceId,
        session,
        nodeId: edge.target,
        updates: { context: result.context },
      });
      continue;
    }

    if (node.type === "set_tag") {
      await executeSetTagNode({
        workspaceId,
        session,
        contact,
        node,
        scope,
      });
      const edge = defaultEdge(version, node.id);
      if (!edge) return completeSession({ workspaceId, session, node });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: edge.target,
      });
      continue;
    }

    if (node.type === "set_attribute") {
      await executeSetAttributeNode({
        workspaceId,
        session,
        contact,
        node,
        scope,
      });
      const edge = defaultEdge(version, node.id);
      if (!edge) return completeSession({ workspaceId, session, node });
      session = await moveSession({
        workspaceId,
        session,
        nodeId: edge.target,
      });
      continue;
    }

    if (node.type === "request_intervention") {
      return requestHandover({
        workspaceId,
        session,
        contact,
        node,
        scope,
      });
    }

    if (node.type === "end") {
      return completeSession({ workspaceId, session, node });
    }

    return { status: "unsupported_node", session };
  }

  session = await moveSession({
    workspaceId,
    session,
    nodeId: session.currentNodeId,
    updates: {
      status: "failed",
      completedAt: new Date(),
      error: { message: "Maximum automatic flow steps exceeded" },
    },
  });
  return { status: "failed", session };
}

async function completeSession({ workspaceId, session, node }) {
  const completed = await moveSession({
    workspaceId,
    session,
    nodeId: node.id,
    updates: {
      status: "completed",
      completedAt: new Date(),
      waitingFor: { type: null, attributeKey: null, nodeId: null },
    },
  });
  await writeEvent({
    workspaceId,
    session: completed,
    eventType: "flow_completed",
    nodeId: node.id,
  });
  return { status: "completed", session: completed };
}

async function failSession({ workspaceId, session, contact }) {
  await sendText({
    workspaceId,
    contact,
    text: GENERIC_END_MESSAGE,
  });
  const failed = await moveSession({
    workspaceId,
    session,
    nodeId: session.currentNodeId,
    updates: {
      status: "failed",
      completedAt: new Date(),
      waitingFor: { type: null, attributeKey: null, nodeId: null },
      error: { message: "Flow could not continue" },
    },
  });
  return { status: "failed", session: failed };
}

function validQuestionAnswer(inputType, value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (inputType === "number") return Number.isFinite(Number(text));
  if (inputType === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  if (inputType === "phone") return text.replace(/\D/g, "").length >= 8;
  return true;
}

async function handleFallback({ workspaceId, session, version, contact }) {
  const updated = await flowSessionRepository.incrementFallbackCount({
    workspaceId,
    sessionId: session._id,
    now: new Date(),
  });
  if (updated.fallbackCount >= MAX_FALLBACKS) {
    if (version.handoverNodeId && nodeById(version, version.handoverNodeId)) {
      const moved = await moveSession({
        workspaceId,
        session: updated,
        nodeId: version.handoverNodeId,
        updates: {
          waitingFor: { type: null, attributeKey: null, nodeId: null },
        },
      });
      return executeSession({
        workspaceId,
        sessionId: moved._id,
      });
    }
    return failSession({ workspaceId, session: updated, contact });
  }
  await sendText({ workspaceId, contact, text: GENERIC_RETRY_MESSAGE });
  return { status: "waiting", session: updated };
}

async function continueSession({
  workspaceId,
  session,
  inboundMessage,
}) {
  const [version, contact] = await Promise.all([
    flowSessionRepository.findFlowVersionById({
      workspaceId,
      flowVersionId: session.flowVersionId,
    }),
    flowSessionRepository.findContactById({
      workspaceId,
      contactId: session.contactId,
    }),
  ]);
  if (!version || !contact) return { status: "failed", session };

  const waiting = session.waitingFor || {};
  let edge = null;
  let context = { ...(session.context || {}) };
  if (waiting.type === "button_reply") {
    edge = edgeForHandle(
      version,
      waiting.nodeId,
      inboundMessage?.buttonReply?.id
    );
  } else if (waiting.type === "list_reply") {
    edge = edgeForHandle(
      version,
      waiting.nodeId,
      inboundMessage?.listReply?.id
    );
  } else if (
    ["text", "number", "email", "phone"].includes(waiting.type)
  ) {
    const answer = inboundMessage?.text;
    if (validQuestionAnswer(waiting.type, answer)) {
      const key = String(waiting.attributeKey || "").trim();
      context = {
        ...context,
        lastAnswer: String(answer).trim(),
        ...(key ? { [key]: String(answer).trim() } : {}),
      };
      edge = defaultEdge(version, waiting.nodeId);
    }
  }

  if (!edge) {
    return handleFallback({ workspaceId, session, version, contact });
  }

  const moved = await moveSession({
    workspaceId,
    session,
    nodeId: edge.target,
    updates: {
      context,
      fallbackCount: 0,
      waitingFor: { type: null, attributeKey: null, nodeId: null },
    },
  });
  return executeSession({
    workspaceId,
    sessionId: moved._id,
    inboundMessage,
  });
}

module.exports = {
  executeSession,
  continueSession,
  resolveVariables,
};
