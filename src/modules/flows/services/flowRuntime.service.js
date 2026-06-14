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
  normalizeRuntimeSettings,
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
    stack: String(error?.stack || "")
      .split("\n")
      .slice(0, 8)
      .map((line) => line.trim())
      .filter(Boolean),
    metaError: error?.outboundFailure?.meta || error?.metaDebug?.meta || null,
    walletError:
      error?.outboundFailure?.walletError ||
      (Number(error?.statusCode || error?.status) === 402
        ? String(error?.message || "Insufficient wallet balance")
        : null),
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

function normalizeHandleText(value) {
  return String(value || "").trim().toLowerCase();
}

function availableEdgesForNode(version, nodeId) {
  return (version.edges || [])
    .filter((edge) => String(edge?.source || "") === String(nodeId || ""))
    .map((edge) => ({
      id: edge.id || null,
      source: edge.source,
      sourceHandle: edge.sourceHandle || "default",
      target: edge.target,
    }));
}

function logEdgeScan({ version, sourceNodeId, sourceHandle }) {
  const availableEdges = availableEdgesForNode(version, sourceNodeId);
  flowLog("[FLOW_EDGE_SCAN]", {
    sourceNodeId,
    sourceHandle,
    availableEdges,
  });
  return availableEdges;
}

function logEdgeResult({ edge, sourceNodeId, sourceHandle, availableEdges }) {
  if (edge) {
    flowLog("[FLOW_EDGE_MATCH]", {
      sourceNodeId,
      sourceHandle,
      targetNodeId: edge.target,
    });
    return;
  }
  flowLog("[FLOW_EDGE_MISSING]", {
    sourceNodeId,
    sourceHandle,
    availableHandles: availableEdges
      .map((item) => item.sourceHandle)
      .filter(Boolean),
    availableEdges,
  });
}

function buttonHandleFromInbound(node, inboundMessage) {
  const explicitId = inboundMessage?.buttonReply?.id;
  if (explicitId) return explicitId;
  const incomingText = normalizeHandleText(
    inboundMessage?.buttonReply?.title || inboundMessage?.text
  );
  if (!incomingText) return "";
  const button = (node?.config?.buttons || []).find(
    (item) =>
      normalizeHandleText(item?.id) === incomingText ||
      normalizeHandleText(item?.title) === incomingText
  );
  return button?.id || "";
}

function listHandleFromInbound(node, inboundMessage) {
  const explicitId = inboundMessage?.listReply?.id;
  if (explicitId) return explicitId;
  const incomingText = normalizeHandleText(
    inboundMessage?.listReply?.title || inboundMessage?.text
  );
  if (!incomingText) return "";
  for (const section of node?.config?.sections || []) {
    const row = (section?.rows || []).find(
      (item) =>
        normalizeHandleText(item?.id) === incomingText ||
        normalizeHandleText(item?.title) === incomingText
    );
    if (row?.id) return row.id;
  }
  return "";
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
  inboundMessage = null,
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
      inboundMessage,
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
        expiresAt: sessionExpiresAt(version.runtimeSettings, sentAt, {
          lastInboundAt:
            inboundMessage?.receivedAt || contact.lastInboundAt || null,
        }),
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

  const [version, contact, flow, workspace] = await Promise.all([
    flowSessionRepository.findFlowVersionById({
      workspaceId,
      flowVersionId: session.flowVersionId,
    }),
    flowSessionRepository.findContactById({
      workspaceId,
      contactId: session.contactId,
    }),
    flowSessionRepository.findFlowById({
      workspaceId,
      flowId: session.flowId,
    }),
    flowSessionRepository.findWorkspaceById({ workspaceId }),
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

    const scope = buildScope(session, contact, inboundMessage, {
      flow,
      workspace,
      node,
    });
    if (node.type === "start") {
      const edge = defaultEdge(version, node.id);
      if (!edge) {
        return failSession({
          workspaceId,
          session,
          contact,
          businessInitiated,
          inboundMessage,
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
          inboundMessage,
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
        inboundMessage,
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
          inboundMessage,
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
            promptSentAt,
            {
              lastInboundAt:
                inboundMessage?.receivedAt || contact.lastInboundAt || null,
            }
          ),
          lastPromptSentAt: promptSentAt,
          lastPromptNodeId: node.id,
          lastPromptMessageStatus: "sent",
          lastPromptFailureReason: null,
          context: {
            ...(session.context || {}),
            lastPrompt: {
              type: "text",
              nodeId: node.id,
              status: "sent",
              sentAt: promptSentAt,
            },
          },
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
          inboundMessage,
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
            promptSentAt,
            {
              lastInboundAt:
                inboundMessage?.receivedAt || contact.lastInboundAt || null,
            }
          ),
          lastPromptSentAt: promptSentAt,
          lastPromptNodeId: node.id,
          lastPromptMessageStatus: "sent",
          lastPromptFailureReason: null,
          context: {
            ...(session.context || {}),
            lastPrompt: {
              type: "list_reply",
              nodeId: node.id,
              status: "sent",
              sentAt: promptSentAt,
            },
          },
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
          inboundMessage,
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
        await sendTemplateNode({
          workspaceId,
          contact,
          node,
          scope,
          inboundMessage,
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
            inboundMessage,
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
  inboundMessage = null,
}) {
  await sendText({
    workspaceId,
    contact,
    text: GENERIC_END_MESSAGE,
    businessInitiated,
    inboundMessage,
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
  inboundMessage = null,
}) {
  const settings = normalizeRuntimeSettings(version.runtimeSettings);
  const updated = await flowSessionRepository.incrementFallbackCount({
    workspaceId,
    sessionId: session._id,
    now: new Date(),
  });
  const maxInvalidReplies = settings.maxInvalidReplies || MAX_FALLBACKS;
  if (updated.fallbackCount >= maxInvalidReplies) {
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
    return failSession({ workspaceId, session: updated, contact, inboundMessage });
  }
  await sendText({
    workspaceId,
    contact,
    text: settings.invalidReplyMessage || GENERIC_RETRY_MESSAGE,
    businessInitiated: false,
    inboundMessage,
  });
  return { status: "waiting", session: updated };
}

async function continueSession({
  workspaceId,
  session,
  inboundMessage,
}) {
  const [version, contact, flow, workspace] = await Promise.all([
    flowSessionRepository.findFlowVersionById({
      workspaceId,
      flowVersionId: session.flowVersionId,
    }),
    flowSessionRepository.findContactById({
      workspaceId,
      contactId: session.contactId,
    }),
    flowSessionRepository.findFlowById({
      workspaceId,
      flowId: session.flowId,
    }),
    flowSessionRepository.findWorkspaceById({ workspaceId }),
  ]);
  if (!version || !contact) return { status: "failed", session };

  const waiting = session.waitingFor || {};
  let edge = null;
  let context = { ...(session.context || {}) };
  flowLog("[FLOW_WAITING_FOR_MATCH]", {
    waitingForType: waiting.type || null,
    expectedNodeId: waiting.nodeId || null,
    incomingType: inboundMessage?.type || null,
    incomingReplyId:
      inboundMessage?.buttonReply?.id || inboundMessage?.listReply?.id || null,
    incomingReplyTitle:
      inboundMessage?.buttonReply?.title ||
      inboundMessage?.listReply?.title ||
      null,
  });
  if (waiting.type === "button_reply") {
    const waitingNode = nodeById(version, waiting.nodeId);
    const buttonId = buttonHandleFromInbound(waitingNode, inboundMessage);
    if (buttonId) {
      flowLog("[FLOW_BUTTON_REPLY_RECEIVED]", {
        sessionId: String(session._id),
        currentNodeId: session.currentNodeId,
        waitingNodeId: waiting.nodeId,
        buttonId,
        buttonTitle:
          inboundMessage?.buttonReply?.title || inboundMessage?.text || "",
      });
    }
    const availableEdges = logEdgeScan({
      version,
      sourceNodeId: waiting.nodeId,
      sourceHandle: buttonId || null,
    });
    edge = edgeForHandle(
      version,
      waiting.nodeId,
      buttonId
    );
    logEdgeResult({
      edge,
      sourceNodeId: waiting.nodeId,
      sourceHandle: buttonId || null,
      availableEdges,
    });
  } else if (waiting.type === "list_reply") {
    const waitingNode = nodeById(version, waiting.nodeId);
    const rowId = listHandleFromInbound(waitingNode, inboundMessage);
    if (rowId) {
      flowLog("[FLOW_LIST_REPLY_RECEIVED]", {
        sessionId: String(session._id),
        currentNodeId: session.currentNodeId,
        waitingNodeId: waiting.nodeId,
        rowId,
        rowTitle: inboundMessage?.listReply?.title || inboundMessage?.text || "",
      });
    }
    const availableEdges = logEdgeScan({
      version,
      sourceNodeId: waiting.nodeId,
      sourceHandle: rowId || null,
    });
    edge = edgeForHandle(
      version,
      waiting.nodeId,
      rowId
    );
    logEdgeResult({
      edge,
      sourceNodeId: waiting.nodeId,
      sourceHandle: rowId || null,
      availableEdges,
    });
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
    if (["button_reply", "list_reply"].includes(waiting.type)) {
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
          node: waitingNode || { id: waiting.nodeId, type: waiting.type },
          error: new Error("Interactive prompt was not successfully sent"),
        });
      }
      const incomingText = String(inboundMessage?.text || "").trim().toLowerCase();
      const restartsFlow = (version.trigger?.keywords || []).some(
        (keyword) => String(keyword || "").trim().toLowerCase() === incomingText
      );
      if (incomingText && restartsFlow && waiting.type === "button_reply" && waitingNode) {
        return sendButtonsAndWait({
          workspaceId,
          session,
          contact,
          node: waitingNode,
          scope: buildScope(session, contact, inboundMessage, {
            flow,
            workspace,
            node: waitingNode,
          }),
          version,
          businessInitiated: false,
          inboundMessage,
        });
      }
      flowLog("[FLOW_STALE_REPLY_OR_WRONG_NODE]", {
        sessionId: String(session._id),
        currentNodeId: session.currentNodeId,
        waitingNodeId: waiting.nodeId,
        waitingForType: waiting.type,
        incomingType: inboundMessage?.type || null,
        incomingText: inboundMessage?.text || "",
        incomingReplyId:
          inboundMessage?.buttonReply?.id || inboundMessage?.listReply?.id || null,
      });
    }
    return handleFallback({ workspaceId, session, version, contact, inboundMessage });
  }

  const moved = await moveSession({
    workspaceId,
    session,
    nodeId: edge.target,
    updates: {
      context,
      fallbackCount: 0,
      waitingFor: { type: null, attributeKey: null, nodeId: null },
      expiresAt: sessionExpiresAt(version.runtimeSettings, new Date(), {
        lastInboundAt: inboundMessage?.receivedAt || contact.lastInboundAt || null,
      }),
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
