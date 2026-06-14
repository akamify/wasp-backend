const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const {
  expireActiveSession,
} = require("@modules/flows/services/flowSession.service");
const {
  normalizeRuntimeSettings,
} = require("@modules/flows/constants/flowRuntimeSettings");
const {
  resolveVariables,
} = require("@modules/flows/services/flowRuntime.utils");
const {
  sendTextMessageForUser,
  sendTemplateMessageForUser,
} = require("@shared/services/outboundMessageService");
const {
  checkCustomerServiceWindow,
} = require("@shared/services/whatsappCustomerWindow");

function flowLog(label, data) {
  process.stdout.write(`${label} ${JSON.stringify(data)}\n`);
}

function serializeFailure(error) {
  return {
    message: String(error?.message || "Expiry notification failed"),
    meta:
      error?.outboundFailure?.meta ||
      error?.metaDebug?.meta ||
      error?.response?.data?.error ||
      null,
  };
}

function expiryScope({ session, contact, flow }) {
  return {
    context: session.context || {},
    contact: {
      id: String(contact._id),
      phone: contact.phone,
      name: contact.name || "",
      email: contact.email || "",
      company: contact.company || "",
    },
    flow: {
      id: String(flow?._id || session.flowId),
      name: flow?.name || "",
    },
  };
}

async function writeNotificationEvent({
  session,
  eventType,
  data,
}) {
  await flowSessionRepository.createFlowEvent({
    workspaceId: session.workspaceId,
    flowId: session.flowId,
    flowVersionId: session.flowVersionId,
    sessionId: session._id,
    contactId: session.contactId,
    eventType,
    nodeId: session.currentNodeId,
    data,
  });
}

async function sendExpiryTemplate({
  session,
  contact,
  flow,
  settings,
}) {
  const config = settings.onSessionExpired;
  const template = await flowSessionRepository.findApprovedTemplate({
    workspaceId: session.workspaceId,
    wabaId: contact.wabaId,
    name: config.templateName,
    languageCode: config.languageCode,
  });
  if (!template) {
    flowLog("[FLOW_EXPIRY_TEMPLATE_MISSING]", {
      sessionId: String(session._id),
      flowId: String(session.flowId),
      templateName: config.templateName,
      languageCode: config.languageCode,
    });
    await writeNotificationEvent({
      session,
      eventType: "session_expiry_notification_skipped",
      data: {
        reason: "template_missing_or_not_approved",
        templateName: config.templateName,
        languageCode: config.languageCode,
      },
    });
    return { status: "skipped_template_missing" };
  }

  const scope = expiryScope({ session, contact, flow });
  const variables = config.variables.map((value) =>
    String(resolveVariables(value, scope))
  );
  try {
    const result = await sendTemplateMessageForUser({
      userId: session.workspaceId,
      contactId: contact._id,
      template,
      to: contact.phone,
      languageCode: config.languageCode,
      variables,
      sentBy: { kind: "system" },
    });
    await writeNotificationEvent({
      session,
      eventType: "session_expiry_notification_sent",
      data: {
        type: "template",
        templateName: config.templateName,
        messageId: result.message?._id
          ? String(result.message._id)
          : null,
      },
    });
    return { status: "sent_template" };
  } catch (error) {
    const failure = serializeFailure(error);
    await flowSessionRepository
      .createFailedExpiryMessage({
        workspaceId: session.workspaceId,
        contact,
        templateName: config.templateName,
        languageCode: config.languageCode,
        error: failure,
      })
      .catch(() => {});
    await writeNotificationEvent({
      session,
      eventType: "session_expiry_notification_failed",
      data: { type: "template", ...failure },
    });
    return { status: "failed_template", error: failure };
  }
}

async function notifyExpiredSession({ session, version, contact, flow }) {
  const settings = normalizeRuntimeSettings(version?.runtimeSettings);
  const config = settings.onSessionExpired;
  if (config.action === "none") return { status: "skipped_none" };

  if (config.action === "template") {
    if (!config.templateName) {
      flowLog("[FLOW_EXPIRY_TEMPLATE_MISSING]", {
        sessionId: String(session._id),
        flowId: String(session.flowId),
        templateName: "",
      });
      return { status: "skipped_template_missing" };
    }
    return sendExpiryTemplate({
      session,
      contact,
      flow,
      settings,
    });
  }

  const conversation =
    await flowSessionRepository.findConversationInboundState({
      workspaceId: session.workspaceId,
      wabaId: contact.wabaId,
      phone: contact.phone,
    });
  const lastInboundAt =
    contact.lastInboundAt ||
    conversation?.lastInboundAt ||
    conversation?.lastCustomerMessageAt ||
    null;
  const window = checkCustomerServiceWindow({
    contact: { _id: contact._id, lastInboundAt },
    sendType: "session_expiry_text",
    businessInitiated: true,
  });
  if (!window.windowOpen) {
    if (config.templateName) {
      return sendExpiryTemplate({
        session,
        contact,
        flow,
        settings,
      });
    }
    flowLog("[WHATSAPP_FREEFORM_BLOCKED_OUTSIDE_WINDOW]", {
      contactId: String(contact._id),
      lastInboundAt,
      sendType: "session_expiry_text",
      businessInitiated: true,
    });
    await writeNotificationEvent({
      session,
      eventType: "session_expiry_notification_skipped",
      data: { reason: "outside_customer_window" },
    });
    return { status: "skipped_outside_customer_window" };
  }

  const text = String(
    resolveVariables(
      config.textMessage,
      expiryScope({ session, contact, flow })
    )
  ).trim();
  if (!text) return { status: "skipped_empty_text" };
  try {
    const result = await sendTextMessageForUser({
      userId: session.workspaceId,
      to: contact.phone,
      text,
      sentBy: { kind: "system" },
    });
    await writeNotificationEvent({
      session,
      eventType: "session_expiry_notification_sent",
      data: {
        type: "text",
        messageId: result.message?._id
          ? String(result.message._id)
          : null,
      },
    });
    return { status: "sent_text" };
  } catch (error) {
    const failure = serializeFailure(error);
    await writeNotificationEvent({
      session,
      eventType: "session_expiry_notification_failed",
      data: { type: "text", ...failure },
    });
    return { status: "failed_text", error: failure };
  }
}

async function sweepExpiredSessions({
  now = new Date(),
  limit = 100,
} = {}) {
  const candidates =
    await flowSessionRepository.findTimedOutActiveSessions({ now, limit });
  let expiredCount = 0;
  for (const candidate of candidates) {
    const expired = await expireActiveSession({
      workspaceId: candidate.workspaceId,
      session: candidate,
      reason: "timeout",
      now,
      requireTimedOut: true,
    });
    if (!expired) continue;
    expiredCount += 1;
    const [version, contact, flow] = await Promise.all([
      flowSessionRepository.findFlowVersionById({
        workspaceId: expired.workspaceId,
        flowVersionId: expired.flowVersionId,
      }),
      flowSessionRepository.findContactById({
        workspaceId: expired.workspaceId,
        contactId: expired.contactId,
      }),
      flowSessionRepository.findFlowById({
        workspaceId: expired.workspaceId,
        flowId: expired.flowId,
      }),
    ]);
    if (!version || !contact) continue;
    await notifyExpiredSession({
      session: expired,
      version,
      contact,
      flow,
    }).catch((error) => {
      flowLog("[FLOW_EXPIRY_NOTIFICATION_FAILED]", {
        sessionId: String(expired._id),
        reason: error?.message || "Unknown error",
      });
    });
  }
  return { scanned: candidates.length, expired: expiredCount };
}

module.exports = {
  notifyExpiredSession,
  sweepExpiredSessions,
};
