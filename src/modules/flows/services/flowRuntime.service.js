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
  sendTextButtonsNode,
  sendListNode,
  sendMediaNode,
  sendTemplateNode,
} = require("@modules/flows/services/flowMessageNodes.service");
const {
  executeApiRequestNode,
} = require("@modules/flows/services/flowApiRequest.service");
const {
  sessionExpiresAt,
} = require("@modules/flows/constants/flowRuntimeSettings");

const MAX_AUTO_STEPS = 50;
const MAX_FALLBACKS = 3;
const GENERIC_RETRY_MESSAGE = "Sorry, I could not understand that. Please try again.";
const GENERIC_END_MESSAGE =
  "Sorry, I could not complete this automation. A team member can assist you.";

function flowLog(label, data) {
  process.stdout.write(`${label} ${JSON.stringify(data)}\n`);
}

function sendFailureData(error) {
  return {
    reason: String(error?.outboundFailure?.message || error?.message || "WhatsApp send failed"),
    metaError: error?.outboundFailure?.meta || error?.metaDebug?.meta || null,
    walletError:
      Number(error?.statusCode || error?.status) === 402
        ? String(error?.message || "Insufficient wallet balance")
        : null,
    outboundMessageId: error?.outboundMessageId
      ? String(error.outboundMessageId)
      : null,
  };
}

function logSessionState(session) {
  flowLog("[FLOW_SESSION_STATE]", {
    sessionId: String(session?._id || ""),
    status: session?.status || null,
    currentNodeId: session?.currentNodeId || null,
    waitingFor: session?.waitingFor || null,
    fallbackCount: Number(session?.fallbackCount || 0),
  });
}

async function failPromptSend({ workspaceId, session, node, error }) {
  const failure = sendFailureData(error);
  flowLog("[FLOW_SEND_FAILED]", {
    nodeType: node.type,
    ...failure,
  });
  const failed = await moveSession({
    workspaceId,
    session,
    nodeId: node.id,
    updates: {
      status: "failed",
      completedAt: new Date(),
      expiryReason: "send_failed",
      expiresAt: new Date(),
      waitingFor: { type: null, attributeKey: null, nodeId: null },
      lastPromptNodeId: node.id,
      lastPromptMessageStatus: "failed",
      lastPromptFailureReason: failure.reason,
      error: {
        message: failure.reason,
        nodeId: node.id,
        nodeType: node.type,
        provider: "meta",
        details: failure,
      },
    },
  });
  await writeEvent({
    workspaceId,
    session: failed,
    eventType: "message_failed",
    nodeId: node.id,
    data: failure,
  });
  logSessionState(failed);
  return { status: "failed", session: failed };
}

async function sendButtonsAndWait({
  workspaceId,
  session,
  contact,
  node,
  scope,
  version,
  businessInitiated = false,
}) {
  flowLog("[FLOW_VERSION_NODE_CONFIG]", {
    flowVersionId: String(session.flowVersionId),
    nodeId: node.id,
    nodeType: node.type,
    text: String(node.config?.text || ""),
    buttonsCount: Array.isArray(node.config?.buttons) ? node.config.buttons.length : 0,
    buttonIds: Array.isArray(node.config?.buttons)
      ? node.config.buttons.map((button) => button?.id)
      : [],
  });
  try {
    const result = await sendTextButtonsNode({
      workspaceId,
      contact,
      node,
      scope,
      businessInitiated,
    });
    const sentAt = new Date();
    const waitingSession = await moveSession({
      workspaceId,
      session,
      nodeId: node.id,
      updates: {
        waitingFor: {
          type: "button_reply",
          attributeKey: null,
          nodeId: node.id,
        },
        expiresAt: sessionExpiresAt(version.runtimeSettings, sentAt),
        lastPromptSentAt: sentAt,
        lastPromptNodeId: node.id,
        lastPromptMessageStatus: "sent",
        lastPromptFailureReason: null,
        context: {
          ...(session.context || {}),
          lastPrompt: {
            type: "button_reply",
            nodeId: node.id,
            status: "sent",
            messageId: result.message?._id ? String(result.message._id) : null,
            providerMessageId: result.message?.whatsappMessageId || null,
            sentAt,
          },
        },
      },
    });
    await writeEvent({
      workspaceId,
      session: waitingSession,
      eventType: "message_sent",
      nodeId: node.id,
      data: {
        messageType: "interactive_buttons",
        messageId: result.message?._id ? String(result.message._id) : null,
        providerMessageId: result.message?.whatsappMessageId || null,
        buttonsCount: Array.isArray(node.config?.buttons) ? node.config.buttons.length : 0,
      },
    });
    logSessionState(waitingSession);
    return { status: "waiting", session: waitingSession };
  } catch (error) {
    return failPromptSend({ workspaceId, session, node, error });
  }
}

async function executeSession({
  workspaceId,
  sessionId,
  inboundMessage = null,
  businessInitiated = inboundMessage == null,
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
      if (!edge) {
        return failSession({
          workspaceId,
          session,
          contact,
          businessInitiated,
        });
      }
      session = await moveSession({
        workspaceId,
        session,
        nodeId: edge.target,
      });
      continue;
    }

    if (node.type === "text") {
      try {
        await sendText({
          workspaceId,
          contact,
          text: resolveVariables(node.config?.text, scope),
          businessInitiated,
        });
      } catch (error) {
        return failPromptSend({ workspaceId, session, node, error });
      }
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
      return sendButtonsAndWait({
        workspaceId,
        session,
        contact,
        node,
        scope,
        version,
        businessInitiated,
      });
    }

    if (node.type === "ask_question") {
      const promptSentAt = new Date();
      try {
        await sendText({
          workspaceId,
          contact,
          text: resolveVariables(node.config?.question, scope),
          businessInitiated,
        });
      } catch (error) {
        return failPromptSend({ workspaceId, session, node, error });
      }
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
          expiresAt: sessionExpiresAt(
            version.runtimeSettings,
            promptSentAt
          ),
          lastPromptSentAt: promptSentAt,
          lastPromptNodeId: node.id,
          lastPromptMessageStatus: "sent",
          lastPromptFailureReason: null,
        },
      });
      return { status: "waiting", session };
    }

    if (node.type === "list") {
      const promptSentAt = new Date();
      try {
        await sendListNode({
          workspaceId,
          contact,
          node,
          scope,
          businessInitiated,
        });
      } catch (error) {
        return failPromptSend({ workspaceId, session, node, error });
      }
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
          expiresAt: sessionExpiresAt(
            version.runtimeSettings,
            promptSentAt
          ),
          lastPromptSentAt: promptSentAt,
          lastPromptNodeId: node.id,
          lastPromptMessageStatus: "sent",
          lastPromptFailureReason: null,
        },
      });
      return { status: "waiting", session };
    }

    if (node.type === "media") {
      try {
        await sendMediaNode({
          workspaceId,
          contact,
          node,
          scope,
          businessInitiated,
        });
      } catch (error) {
        return failPromptSend({ workspaceId, session, node, error });
      }
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
      try {
        await sendTemplateNode({ workspaceId, contact, node, scope });
      } catch (error) {
        return failPromptSend({ workspaceId, session, node, error });
      }
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
      try {
        return await requestHandover({
          workspaceId,
          session,
          contact,
          node,
          scope,
          businessInitiated,
        });
      } catch (error) {
        return failPromptSend({ workspaceId, session, node, error });
      }
    }

    if (node.type === "end") {
      const endMessage = String(
        resolveVariables(node.config?.message || "", scope)
      ).trim();
      if (endMessage) {
        try {
          await sendText({
            workspaceId,
            contact,
            text: endMessage,
            businessInitiated,
          });
        } catch (error) {
          return failPromptSend({ workspaceId, session, node, error });
        }
      }
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
      expiryReason: "completed",
      expiresAt: new Date(),
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

async function failSession({
  workspaceId,
  session,
  contact,
  businessInitiated = false,
}) {
  await sendText({
    workspaceId,
    contact,
    text: GENERIC_END_MESSAGE,
    businessInitiated,
  }).catch(() => {});
  const failed = await moveSession({
    workspaceId,
    session,
    nodeId: session.currentNodeId,
    updates: {
      status: "failed",
      completedAt: new Date(),
      expiresAt: new Date(),
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

async function handleFallback({
  workspaceId,
  session,
  version,
  contact,
}) {
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
        businessInitiated: false,
      });
    }
    return failSession({ workspaceId, session: updated, contact });
  }
  await sendText({
    workspaceId,
    contact,
    text: GENERIC_RETRY_MESSAGE,
    businessInitiated: false,
  });
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
    const buttonId = inboundMessage?.buttonReply?.id;
    if (buttonId) {
      flowLog("[FLOW_BUTTON_REPLY_RECEIVED]", {
        sessionId: String(session._id),
        buttonId,
        buttonTitle: inboundMessage?.buttonReply?.title || "",
      });
    }
    edge = edgeForHandle(
      version,
      waiting.nodeId,
      buttonId
    );
    if (edge) {
      flowLog("[FLOW_BUTTON_EDGE_MATCH]", {
        sourceNodeId: waiting.nodeId,
        sourceHandle: buttonId,
        targetNodeId: edge.target,
      });
    } else if (buttonId) {
      flowLog("[FLOW_BUTTON_EDGE_MISSING]", {
        buttonId,
        availableHandles: (version.edges || [])
          .filter((item) => String(item?.source) === String(waiting.nodeId))
          .map((item) => item?.sourceHandle)
          .filter(Boolean),
      });
    }
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
    if (waiting.type === "button_reply") {
      const waitingNode = nodeById(version, waiting.nodeId);
      const lastPrompt = session.context?.lastPrompt;
      if (
        !lastPrompt ||
        lastPrompt.status !== "sent" ||
        String(lastPrompt.nodeId || "") !== String(waiting.nodeId || "")
      ) {
        return failPromptSend({
          workspaceId,
          session,
          node: waitingNode || { id: waiting.nodeId, type: "text_buttons" },
          error: new Error("Interactive button prompt was not successfully sent"),
        });
      }
      const incomingText = String(inboundMessage?.text || "").trim().toLowerCase();
      const restartsFlow = (version.trigger?.keywords || []).some(
        (keyword) => String(keyword || "").trim().toLowerCase() === incomingText
      );
      if (incomingText && restartsFlow && waitingNode) {
        return sendButtonsAndWait({
          workspaceId,
          session,
          contact,
          node: waitingNode,
          scope: buildScope(session, contact, inboundMessage),
          version,
          businessInitiated: false,
        });
      }
    }
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
    businessInitiated: false,
  });
}

module.exports = {
  executeSession,
  continueSession,
  resolveVariables,
};
