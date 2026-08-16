const mongoose = require("mongoose");
const { Message } = require("@infra/database/Message");
const { AiAgent } = require("@infra/database/AiAgent");
const { Template } = require("@infra/database/Template");
const {
  findTenantByPhoneNumberId,
} = require("@shared/services/credentialsService");
const {
  normalizePhone,
  resolveInboundContact,
} = require("@shared/services/contactService");
const flowInboundRepository = require("@modules/flows/repositories/flowInbound.repository");
const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const aiToolService = require("@modules/ai-agents/services/aiTool.service");
const {
  sendTemplateMessageForUser,
} = require("@shared/services/outboundMessageService");
const {
  findMatchingFlowVersion,
} = require("@modules/flows/services/flowTrigger.service");
const {
  findLatestActiveSession,
  expireActiveSession,
  allowsKeywordRestart,
  shouldSkipForHandover,
  startSession,
} = require("@modules/flows/services/flowSession.service");
const {
  executeSession,
  continueSession,
} = require("@modules/flows/services/flowRuntime.service");

function flowLog(label, data) {
  process.stdout.write(`${label} ${JSON.stringify(data)}\n`);
}

async function startMatchedFlow({
  workspaceId,
  contact,
  match,
  inboundMessage,
  now,
}) {
  const session = await startSession({
    workspaceId,
    contactId: contact._id,
    flow: match.flow,
    version: match.version,
    initialContext: {},
    now,
  });
  const runtimeResult = await executeSession({
    workspaceId,
    sessionId: session._id,
    inboundMessage,
    businessInitiated: false,
  });
  return { session, runtimeResult };
}

function isDuplicateKeyError(error) {
  return (
    Number(error?.code) === 11000 ||
    /duplicate key/i.test(String(error?.message || ""))
  );
}

function serializeError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || "Inbound message processing failed"),
  };
}

function aiButtonLog(reason, data = {}) {
  flowLog("[FLOW_AI_BUTTON_RESOLUTION]", {
    reason,
    ...data,
  });
}

function normalizeAiInteractiveActions(value, key) {
  const actions = value?.payload?.[key] || null;
  if (!actions || typeof actions !== "object") return null;
  if (Number(actions.version || 1) !== 1) return null;
  const items = Array.isArray(actions.actions) ? actions.actions : Array.isArray(actions.buttons) ? actions.buttons : [];
  return { ...actions, actions: items };
}

function resolveAiTemplateVariables({ assignedTemplate, contact }) {
  const allowed = Array.isArray(assignedTemplate?.allowedVariables)
    ? assignedTemplate.allowedVariables.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!allowed.length) return { ok: true, variables: [] };
  const source = {
    name: contact?.name || "",
    phone: contact?.phone || "",
    email: contact?.email || "",
    company: contact?.company || "",
  };
  const variables = [];
  const missing = [];
  for (const key of allowed) {
    const value = String(source[key] || "").trim();
    if (!value) missing.push(key);
    else variables.push(value);
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, variables };
}

async function findAiInteractiveActionMatch({ workspaceId, inboundMessage }) {
  const inboundType = String(inboundMessage?.type || "");
  if (!["button_reply", "list_reply"].includes(inboundType)) return null;
  const contextWamid = String(inboundMessage?.context?.id || "").trim();
  const clickedId = String(
    inboundType === "button_reply"
      ? inboundMessage?.buttonReply?.id
      : inboundMessage?.listReply?.id
  ).trim();
  if (!contextWamid || !clickedId) return null;

  const origin = await flowSessionRepository.findOutboundMessageByWamid({
    workspaceId,
    wamid: contextWamid,
  });
  if (!origin) {
    aiButtonLog("origin_not_found", { contextWamid });
    return null;
  }
  const metadataKey = inboundType === "button_reply" ? "aiButtonActions" : "aiListActions";
  const aiActions = normalizeAiInteractiveActions(origin, metadataKey);
  if (!aiActions) return null;

  const action = aiActions.actions.find(
    (item) => String(item?.id || item?.key || "").trim() === clickedId
  );
  if (!action) {
    aiButtonLog("button_not_configured", {
      contextWamid,
      clickedId,
      originMessageId: String(origin._id || ""),
    });
    return null;
  }

  const agentId = String(aiActions.agentId || origin.aiAgentId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(agentId)) return null;
  const agent = await AiAgent.findOne({
    _id: agentId,
    workspaceId,
    deletedAt: null,
    status: "active",
  });
  if (!agent) return null;

  const assigned = aiToolService.resolveAssignedAction(agent, action.key || action.id);
  const actionKind = String(action.kind || (action.action?.type === "start_flow" ? "flow" : "")).trim();
  if (!assigned || (actionKind && String(assigned.kind) !== actionKind)) {
    aiButtonLog("assigned_action_not_authorized", {
      contextWamid,
      clickedId,
      key: action.key || action.id || null,
      kind: actionKind || null,
    });
    return null;
  }

  if (assigned.kind === "flow") {
    const flowId = String(assigned.serverConfig?.flowId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(flowId)) {
      aiButtonLog("invalid_flow_id", { contextWamid, clickedId });
      return null;
    }

    const flow = await flowSessionRepository.findActivePublishedFlowForAiAction({
      workspaceId,
      flowId,
    });
    const version = flow?.activeVersionId || null;
    if (!flow || !version) {
      aiButtonLog("flow_not_active_or_published", {
        contextWamid,
        clickedId,
        flowId,
      });
      return null;
    }

    return {
      type: "flow",
      flow,
      version,
      origin,
      action,
      assigned,
      agent,
      contextWamid,
      clickedId,
    };
  }

  if (assigned.kind === "template") {
    const template = await Template.findOne({
      _id: assigned.serverConfig?.templateId,
      workspaceId,
      ...(origin.wabaId ? { wabaId: origin.wabaId } : {}),
      status: "approved",
      isActive: { $ne: false },
      deletedAt: null,
    });
    if (!template) return null;
    return {
      type: "template",
      template,
      origin,
      action,
      assigned,
      agent,
      contextWamid,
      clickedId,
    };
  }

  aiButtonLog("unsupported_action_kind", {
    contextWamid,
    clickedId,
    kind: assigned.kind,
  });
  return null;
}

async function startAiButtonFlow({
  workspaceId,
  contact,
  match,
  inboundMessage,
  now,
}) {
  const session = await startSession({
    workspaceId,
    contactId: contact._id,
    flow: match.flow,
    version: match.version,
    initialContext: {
      aiButtonAction: {
        buttonId: match.clickedId,
        title: String(match.action?.title || inboundMessage?.buttonReply?.title || inboundMessage?.listReply?.title || "").trim(),
        originMessageId: String(match.origin?._id || ""),
        originWhatsappMessageId: match.contextWamid,
      },
    },
    now,
  });
  const runtimeResult = await executeSession({
    workspaceId,
    sessionId: session._id,
    inboundMessage,
    businessInitiated: false,
  });
  return { session, runtimeResult };
}

async function executeAiInteractiveAction({
  workspaceId,
  contact,
  match,
  inboundMessage,
  now,
}) {
  if (match.type === "flow") {
    return startAiButtonFlow({ workspaceId, contact, match, inboundMessage, now });
  }
  if (match.type === "template") {
    const resolved = resolveAiTemplateVariables({
      assignedTemplate: match.assigned.serverConfig,
      contact,
    });
    if (!resolved.ok) {
      aiButtonLog("template_variables_missing", {
        contextWamid: match.contextWamid,
        clickedId: match.clickedId,
        missing: resolved.missing || [],
      });
      return { failed: true, reason: "template_variables_missing" };
    }
    const result = await sendTemplateMessageForUser({
      userId: workspaceId,
      contactId: contact?._id || undefined,
      to: contact.phone,
      template: match.template,
      languageCode: match.template.languageCode || match.template.language,
      variables: resolved.variables,
      idempotencyKey: `ai-click:${inboundMessage.whatsappMessageId}:${match.clickedId}`,
      sentBy: { kind: "system" },
      source: "automation",
      senderType: "automation",
      triggeredByMessageId: inboundMessage.whatsappMessageId || null,
      aiAgentId: match.agent?._id || null,
      aiActionMetadata: {
        aiInteractiveClickAction: {
          key: match.assigned.key,
          kind: match.assigned.kind,
          originWhatsappMessageId: match.contextWamid,
        },
      },
    });
    return { templateResult: result };
  }
  return { failed: true, reason: "unsupported_action_kind" };
}

async function persistInboundDisplayMessage({
  workspaceId,
  wabaId,
  phoneNumberId,
  from,
  normalizedMessage,
  contact,
}) {
  const type = String(normalizedMessage?.type || "unknown");
  const buttonReply = normalizedMessage?.buttonReply || null;
  const listReply = normalizedMessage?.listReply || null;
  const displayText =
    normalizedMessage?.text ||
    buttonReply?.title ||
    listReply?.title ||
    "";
  const replyToMessageId = String(normalizedMessage?.context?.id || "").trim();
  const receivedAt = normalizedMessage?.receivedAt || new Date();
  const interactive = buttonReply
    ? {
        type: "button_reply",
        id: buttonReply.id || null,
        title: buttonReply.title || null,
      }
    : listReply
      ? {
          type: "list_reply",
          id: listReply.id || null,
          title: listReply.title || null,
          description: listReply.description || null,
        }
      : null;
  await Message.findOneAndUpdate(
    {
      workspaceId,
      ...(wabaId ? { wabaId } : {}),
      whatsappMessageId: normalizedMessage.whatsappMessageId,
    },
    {
      $set: {
        workspaceId,
        wabaId: wabaId || null,
        phoneNumberId: phoneNumberId || null,
        contactId: contact?._id || null,
        phone: from,
        direction: "inbound",
        senderType: "user",
        source: "whatsapp",
        type,
        status: "received",
        "statusTimestamps.receivedAt": receivedAt,
        receivedAt,
        sortAt: receivedAt,
        sentBy: { kind: "system" },
        replyToMessageId: replyToMessageId || null,
        text: displayText,
        displayText,
        previewText: displayText,
        ...(buttonReply
          ? {
              buttonReply: {
                id: buttonReply.id || null,
                title: buttonReply.title || null,
              },
            }
          : {}),
        ...(listReply
          ? {
              listReply: {
                id: listReply.id || null,
                title: listReply.title || null,
                description: listReply.description || null,
              },
            }
          : {}),
        ...(interactive ? { interactive } : {}),
        payload: normalizedMessage.rawPayload || null,
      },
      $setOnInsert: { createdAt: receivedAt },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).catch((error) => {
    console.warn("[flow-inbound] display message persistence failed", {
      workspaceId: String(workspaceId || ""),
      reason: error?.message || "unknown",
    });
  });
}

async function resolveMessageContext(normalizedMessage) {
  const phoneNumberId = String(
    normalizedMessage?.phoneNumberId || ""
  ).trim();
  if (!phoneNumberId) return null;

  const tenant = await findTenantByPhoneNumberId(phoneNumberId);
  const resolvedWorkspaceId = String(tenant?.workspaceId || "");
  if (!mongoose.Types.ObjectId.isValid(resolvedWorkspaceId)) return null;

  const requestedWorkspaceId = String(
    normalizedMessage?.workspaceId || ""
  ).trim();
  if (
    requestedWorkspaceId &&
    requestedWorkspaceId !== resolvedWorkspaceId
  ) {
    return null;
  }

  return {
    workspaceId: resolvedWorkspaceId,
    wabaId: String(
      tenant?.wabaId || tenant?.businessAccountIdPlain || ""
    ).trim(),
  };
}

async function processInboundMessage(normalizedMessage) {
  let inboundMessage = null;
  let workspaceId = null;

  try {
    const context = await resolveMessageContext(normalizedMessage);
    if (!context) {
      console.warn("[flow-inbound] workspace not resolved", {
        phoneNumberIdPresent: Boolean(normalizedMessage?.phoneNumberId),
        whatsappMessageIdPresent: Boolean(
          normalizedMessage?.whatsappMessageId
        ),
      });
      return { status: "skipped_no_workspace" };
    }

    workspaceId = context.workspaceId;
    const from = normalizePhone(normalizedMessage?.from);
    const whatsappMessageId = String(
      normalizedMessage?.whatsappMessageId || ""
    ).trim();
    if (!from || !whatsappMessageId) {
      return { status: "failed" };
    }

    try {
      inboundMessage = await flowInboundRepository.createInboundMessage({
        workspaceId,
        contactId: null,
        phoneNumberId: String(
          normalizedMessage?.phoneNumberId || ""
        ).trim(),
        from,
        whatsappMessageId,
        type: String(normalizedMessage?.type || "unknown"),
        text: normalizedMessage?.text || null,
        buttonReply: normalizedMessage?.buttonReply || null,
        listReply: normalizedMessage?.listReply || null,
        rawPayload: normalizedMessage?.rawPayload || null,
        processingStatus: "pending",
        receivedAt: normalizedMessage?.receivedAt || new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return { status: "skipped_duplicate" };
      }
      throw error;
    }

    const contact = await resolveInboundContact({
      workspaceId,
      wabaId: context.wabaId,
      phoneNumberId: normalizedMessage.phoneNumberId,
      phone: from,
      profileName: normalizedMessage.profileName,
      occurredAt: normalizedMessage.receivedAt,
      preview:
        normalizedMessage.text ||
        normalizedMessage.buttonReply?.title ||
        normalizedMessage.listReply?.title ||
        "",
    });
    await persistInboundDisplayMessage({
      workspaceId,
      wabaId: context.wabaId,
      phoneNumberId: String(normalizedMessage?.phoneNumberId || "").trim(),
      from,
      normalizedMessage,
      contact,
    });
    flowLog("[FLOW_INBOUND_NORMALIZED]", {
      workspaceId: String(workspaceId),
      contactId: String(contact._id),
      messageId: normalizedMessage.whatsappMessageId || null,
      type: normalizedMessage.type || null,
      text: normalizedMessage.text || "",
      buttonReply: normalizedMessage.buttonReply || null,
      listReply: normalizedMessage.listReply || null,
      timestamp: normalizedMessage.receivedAt || null,
    });

    const now = new Date();
    let automationResult = { status: "no_trigger_match" };
    if (
      await shouldSkipForHandover({
        workspaceId,
        contact,
        inboundMessage: normalizedMessage,
      })
    ) {
      automationResult = { status: "skipped_handover" };
    } else {
      let existingSession = await findLatestActiveSession({
        workspaceId,
        contactId: contact._id,
      });
      if (
        existingSession?.expiresAt &&
        new Date(existingSession.expiresAt).getTime() <= now.getTime()
      ) {
        await expireActiveSession({
          workspaceId,
          session: existingSession,
          reason: "timeout",
          now,
          requireTimedOut: true,
        });
        existingSession = null;
      }

      if (existingSession) {
        flowLog("[FLOW_ACTIVE_SESSION_FOUND]", {
          sessionId: String(existingSession._id),
          status: existingSession.status,
          currentNodeId: existingSession.currentNodeId || null,
          waitingFor: existingSession.waitingFor || null,
          lastPromptNodeId: existingSession.lastPromptNodeId || null,
          lastPromptMessageStatus:
            existingSession.lastPromptMessageStatus || null,
          expiresAt: existingSession.expiresAt || null,
        });
        const restartMatch = await findMatchingFlowVersion({
          workspaceId,
          inboundMessage: normalizedMessage,
        });
        const restartAllowed =
          restartMatch &&
          (await allowsKeywordRestart({
            workspaceId,
            session: existingSession,
          }));
        if (restartAllowed) {
          const oldSessionId = String(existingSession._id);
          await expireActiveSession({
            workspaceId,
            session: existingSession,
            reason: "replaced",
            now,
          });
          const { session, runtimeResult } = await startMatchedFlow({
            workspaceId,
            contact,
            match: restartMatch,
            inboundMessage: normalizedMessage,
            now,
          });
          flowLog("[FLOW_KEYWORD_RESTART]", {
            workspaceId: String(workspaceId),
            contactId: String(contact._id),
            oldSessionId,
            newSessionId: String(session._id),
            flowId: String(restartMatch.flow._id),
            keyword: normalizedMessage.text || "",
          });
          automationResult = {
            status: "session_started",
            sessionId: String(session._id),
            flowId: String(restartMatch.flow._id),
            flowVersionId: String(restartMatch.version._id),
            runtimeStatus: runtimeResult.status,
            replacedSessionId: oldSessionId,
          };
        } else {
          const runtimeResult = await continueSession({
            workspaceId,
            session: existingSession,
            inboundMessage: normalizedMessage,
          });
          automationResult = {
            status:
              runtimeResult.status === "handover"
                ? "skipped_handover"
                : "existing_session_found",
            sessionId: String(existingSession._id),
            sessionStatus:
              runtimeResult.session?.status || existingSession.status,
            runtimeStatus: runtimeResult.status,
          };
        }
      } else {
        const aiActionMatch = await findAiInteractiveActionMatch({
          workspaceId,
          inboundMessage: normalizedMessage,
        });
        if (aiActionMatch) {
          const actionResult = await executeAiInteractiveAction({
            workspaceId,
            contact,
            match: aiActionMatch,
            inboundMessage: normalizedMessage,
            now,
          });
          if (aiActionMatch.type === "flow" && actionResult?.session) {
            const { session, runtimeResult } = actionResult;
            flowLog("[FLOW_AI_INTERACTIVE_FLOW_STARTED]", {
              workspaceId: String(workspaceId),
              contactId: String(contact._id),
              sessionId: String(session._id),
              flowId: String(aiActionMatch.flow._id),
              originWhatsappMessageId: aiActionMatch.contextWamid,
              actionKey: aiActionMatch.clickedId,
            });
            automationResult = {
              status: "session_started",
              sessionId: String(session._id),
              flowId: String(aiActionMatch.flow._id),
              flowVersionId: String(aiActionMatch.version._id),
              runtimeStatus: runtimeResult.status,
              source: "ai_interactive_action",
            };
          } else if (aiActionMatch.type === "template" && actionResult?.templateResult) {
            automationResult = {
              status: "ai_interactive_action_sent",
              source: "ai_interactive_action",
              actionKind: "template",
            };
          } else if (actionResult?.failed) {
            automationResult = {
              status: "ai_interactive_action_failed",
              source: "ai_interactive_action",
              actionKind: aiActionMatch.type,
              reason: actionResult.reason || "action_failed",
            };
          }
        }
        if (automationResult.status === "no_trigger_match") {
        if (
          ["button_reply", "list_reply"].includes(
            String(normalizedMessage.type || "")
          )
        ) {
          flowLog("[FLOW_STALE_REPLY_OR_WRONG_NODE]", {
            workspaceId: String(workspaceId),
            contactId: String(contact._id),
            reason: "no_active_session",
            incomingType: normalizedMessage.type,
            incomingReplyId:
              normalizedMessage.buttonReply?.id ||
              normalizedMessage.listReply?.id ||
              null,
          });
        }
        const match = await findMatchingFlowVersion({
          workspaceId,
          inboundMessage: normalizedMessage,
        });
        if (match) {
          const { session, runtimeResult } = await startMatchedFlow({
            workspaceId,
            contact,
            match,
            inboundMessage: normalizedMessage,
            now,
          });
          automationResult = {
            status: "session_started",
            sessionId: String(session._id),
            flowId: String(match.flow._id),
            flowVersionId: String(match.version._id),
            runtimeStatus: runtimeResult.status,
          };
        }
        }
      }
    }

    await flowInboundRepository.markInboundMessageProcessed({
      workspaceId,
      inboundMessageId: inboundMessage._id,
      contactId: contact?._id || null,
      processedAt: now,
    });

    return {
      ...automationResult,
      inboundMessageId: String(inboundMessage._id),
      contactId: contact?._id ? String(contact._id) : null,
    };
  } catch (error) {
    if (workspaceId && inboundMessage?._id) {
      await flowInboundRepository
        .markInboundMessageFailed({
          workspaceId,
          inboundMessageId: inboundMessage._id,
          error: serializeError(error),
          processedAt: new Date(),
        })
        .catch(() => {});
    }
    console.warn("[flow-inbound] processing failed", {
      workspaceId,
      error: error?.message || "Unknown error",
    });
    return { status: "failed" };
  }
}

module.exports = {
  processInboundMessage,
};
