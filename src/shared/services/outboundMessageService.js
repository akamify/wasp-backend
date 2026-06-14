const { Message } = require("@infra/database/Message");
const { Conversation } = require("@infra/database/Conversation");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const {
  sendTemplateMessage,
  sendTextMessage,
  sendInteractiveButtonMessage,
  sendInteractiveListMessage,
  sendMediaMessage,
} = require("@shared/utils/whatsappSender");
const { touchConversation } = require("@shared/services/conversationService");
const { touchContactFromMessage } = require("@shared/services/contactService");
const { Campaign } = require("@infra/database/Campaign");
const {
  buildComponentsFromTemplate,
  normalizeTemplate,
  renderTemplatePreview,
} = require("@shared/utils/templateStructure");
const { assertTemplateBelongsToWaba } = require("@shared/services/templateOwnershipService");
const { HttpError } = require("@shared/utils/httpError");

function isMissingMetaTemplate(err) {
  const message = String(
    err?.metaDebug?.meta?.message ||
      err?.metaDebug?.raw?.error?.message ||
      err?.response?.data?.error?.message ||
      ""
  ).toLowerCase();
  return message.includes("template name does not exist") || message.includes("template does not exist");
}

function throwIfPhoneNotRegistered(err) {
  const code = Number(
    err?.metaDebug?.meta?.code ||
      err?.metaDebug?.raw?.error?.code ||
      err?.response?.data?.error?.code
  );
  if (code === 133010) {
    throw new HttpError(
      400,
      "This phone number is connected but not registered on WhatsApp Cloud API yet."
    );
  }
}

function outboundFailure(error) {
  const meta = error?.metaDebug?.meta || error?.metaDebug?.raw?.error || null;
  return {
    message: String(error?.message || "WhatsApp send failed"),
    provider: "meta",
    status: error?.metaDebug?.axios?.status || error?.response?.status || null,
    meta: meta
      ? {
          message: meta.message || null,
          type: meta.type || null,
          code: meta.code || null,
          error_subcode: meta.error_subcode || null,
          error_user_title: meta.error_user_title || null,
          error_user_msg: meta.error_user_msg || null,
          fbtrace_id: meta.fbtrace_id || null,
        }
      : null,
  };
}

function expectedOutboundFailure(error) {
  const failure = outboundFailure(error);
  const message = String(error?.message || "").toLowerCase();
  if (Number(error?.statusCode || error?.status) === 402) {
    return {
      ...failure,
      reason: "insufficient_wallet_balance",
      walletError: error?.message || "Insufficient wallet balance",
    };
  }
  if (message.includes("waba") || message.includes("credential")) {
    return { ...failure, reason: "waba_not_connected" };
  }
  if (failure.meta) return { ...failure, reason: "meta_api_error" };
  return { ...failure, reason: "send_failed" };
}

async function sendTemplateMessageForUser({
  userId,
  campaignId,
  campaignRunId,
  contactId,
  messageId,
  template,
  to,
  languageCode,
  variables,
  headerVariables,
  otpCode,
  buttonValues,
  buttonTtlMinutes,
  flowTokens,
  flowActionData,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
}) {
  const creds = await getCredentialsForUser(userId);
  assertTemplateBelongsToWaba(template, creds.wabaId);
  const resolvedLanguageCode = String(languageCode || template?.languageCode || template?.language || "").trim();
  const templateLanguageCode = String(template?.languageCode || template?.language || "").trim();
  if (!templateLanguageCode || resolvedLanguageCode !== templateLanguageCode) {
    throw new HttpError(
      409,
      "Template does not exist for the currently connected WhatsApp account. Refresh templates or create this template for the active WABA."
    );
  }
  const normalizedTemplate = normalizeTemplate(template.toObject ? template.toObject() : template);
  const sendComponents = buildComponentsFromTemplate(normalizedTemplate, {
    variables,
    headerVariables,
    otpCode,
    buttonValues,
    buttonTtlMinutes,
    flowTokens,
    flowActionData,
  });
  const previewText = renderTemplatePreview(normalizedTemplate, {
    variables,
    headerVariables,
    otpCode,
  });

  let apiResponse;
  try {
    apiResponse = await sendTemplateMessage({
      accessToken: creds.accessToken,
      phoneNumberId: creds.phoneNumberId,
      to,
      templateName: normalizedTemplate.name,
      languageCode: resolvedLanguageCode,
      components: sendComponents,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throwIfPhoneNotRegistered(err);
    if (isMissingMetaTemplate(err) && template?._id) {
      await require("@infra/database/Template").Template.updateOne(
        { _id: template._id, workspaceId: userId, wabaId: creds.wabaId },
        { $set: { isActive: false, staleReason: "missing_from_meta_send" } }
      ).catch(() => {});
      throw new HttpError(
        409,
        "Template does not exist for the currently connected WhatsApp account. Refresh templates or create this template for the active WABA."
      );
    }
    throw err;
  }

  const waMessageId = Array.isArray(apiResponse?.messages)
    ? apiResponse.messages[0]?.id
    : undefined;
  const waId = Array.isArray(apiResponse?.contacts) ? apiResponse.contacts[0]?.wa_id : undefined;
  const resolvedPhone = waId ? String(waId) : to;

  const now = new Date();

  const messageData = {
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    ...(campaignId ? { campaignId } : {}),
    ...(campaignRunId ? { campaignRunId } : {}),
    ...(contactId ? { contactId } : {}),
    templateId: normalizedTemplate._id,
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "owner" },
    text: previewText,
    payload: {
      to,
      template: {
        name: normalizedTemplate.name,
        language: resolvedLanguageCode,
      },
      runtime: {
        variables: variables || [],
        headerVariables: headerVariables || [],
        otpCode: otpCode || "",
        buttonValues: buttonValues || [],
        buttonTtlMinutes: buttonTtlMinutes || [],
        flowTokens: flowTokens || [],
        flowActionData: flowActionData || [],
      },
      components: sendComponents,
    },
  };
  const message = messageId
    ? await Message.findOneAndUpdate(
        { _id: messageId, workspaceId: userId },
        { $set: messageData, $unset: { error: 1 } },
        { new: true }
      )
    : await Message.create(messageData);
  if (!message) throw new Error("Outbound message reservation not found");

  const conversation = await touchConversation({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    lastMessageAt: now,
    lastMessagePreview: previewText,
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    direction: "outbound",
    preview: previewText,
    occurredAt: now,
  });

  // SLA fields (best-effort; don't block send flow).
  if (conversation) {
    const patch = { lastEmployeeReplyAt: now };
    if (!conversation.firstResponseAt && conversation.lastCustomerMessageAt) {
      patch.firstResponseAt = now;
      patch.firstResponseDurationMs = Math.max(0, now.getTime() - new Date(conversation.lastCustomerMessageAt).getTime());
    }
    await Conversation.updateOne({ _id: conversation._id }, { $set: patch }).catch(() => {});
  }

  // Snapshot CRM ownership/status at send time for future analytics.
  if (conversation) {
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          lastAssignedEmployeeId: conversation.assignedEmployeeId || null,
          lastAssignedAt: conversation.assignedAt || null,
          leadStatusSnapshot: conversation.leadStatus || null,
        },
      }
    ).catch(() => {});
  }

  // Best-effort: mark campaign as running as soon as we create the outbound message.
  if (campaignId) {
    try {
      await Campaign.updateOne(
        { _id: campaignId, workspaceId: userId, status: { $in: ["draft", "queued"] } },
        { $set: { status: "running" } }
      );
    } catch {}
  }

  return { message, apiResponse };
}

async function sendTextMessageForUser({
  userId,
  to,
  text,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
}) {
  const creds = await getCredentialsForUser(userId);
  let apiResponse;
  try {
    apiResponse = await sendTextMessage({
      accessToken: creds.accessToken,
      phoneNumberId: creds.phoneNumberId,
      to,
      text,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throwIfPhoneNotRegistered(err);
    throw err;
  }

  const waMessageId = Array.isArray(apiResponse?.messages) ? apiResponse.messages[0]?.id : undefined;
  const waId = Array.isArray(apiResponse?.contacts) ? apiResponse.contacts[0]?.wa_id : undefined;
  const resolvedPhone = waId ? String(waId) : to;
  const now = new Date();

  const message = await Message.create({
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "owner" },
    text,
    payload: { to, text },
  });

  const conversation = await touchConversation({ userId, wabaId: creds.wabaId, phoneNumberId: creds.phoneNumberId, phone: resolvedPhone, lastMessageAt: now, lastMessagePreview: text, incrementUnread: false });
  await touchContactFromMessage({ userId, wabaId: creds.wabaId, phoneNumberId: creds.phoneNumberId, phone: resolvedPhone, direction: "outbound", preview: text, occurredAt: now });
  if (conversation) {
    const patch = { lastEmployeeReplyAt: now };
    if (!conversation.firstResponseAt && conversation.lastCustomerMessageAt) {
      patch.firstResponseAt = now;
      patch.firstResponseDurationMs = Math.max(0, now.getTime() - new Date(conversation.lastCustomerMessageAt).getTime());
    }
    await Conversation.updateOne({ _id: conversation._id }, { $set: patch }).catch(() => {});
  }
  if (conversation) {
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          lastAssignedEmployeeId: conversation.assignedEmployeeId || null,
          lastAssignedAt: conversation.assignedAt || null,
          leadStatusSnapshot: conversation.leadStatus || null,
        },
      }
    ).catch(() => {});
  }

  return { message, apiResponse };
}

async function sendInteractiveListMessageForUser({
  userId,
  to,
  text,
  buttonText,
  sections,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
}) {
  const creds = await getCredentialsForUser(userId);
  let apiResponse;
  try {
    apiResponse = await sendInteractiveListMessage({
      accessToken: creds.accessToken,
      phoneNumberId: creds.phoneNumberId,
      to,
      text,
      buttonText,
      sections,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throwIfPhoneNotRegistered(err);
    throw err;
  }

  const whatsappMessageId = Array.isArray(apiResponse?.messages)
    ? apiResponse.messages[0]?.id
    : undefined;
  const waId = Array.isArray(apiResponse?.contacts)
    ? apiResponse.contacts[0]?.wa_id
    : undefined;
  const resolvedPhone = waId ? String(waId) : to;
  const now = new Date();
  const message = await Message.create({
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    type: "interactive_list",
    whatsappMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "system" },
    text,
    payload: {
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text },
        action: { button: buttonText, sections },
      },
    },
  });
  const mediaPreview =
    normalizedType === "document"
      ? String(filename || "Document")
      : normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1);

  const conversation = await touchConversation({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    lastMessageAt: now,
    lastMessagePreview: text,
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    direction: "outbound",
    preview: text,
    occurredAt: now,
  });
  if (conversation) {
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          lastAssignedEmployeeId: conversation.assignedEmployeeId || null,
          lastAssignedAt: conversation.assignedAt || null,
          leadStatusSnapshot: conversation.leadStatus || null,
        },
      }
    ).catch(() => {});
  }
  return { message, apiResponse };
}

async function sendInteractiveButtonMessageForUser({
  userId,
  contactId,
  to,
  text,
  buttons,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
}) {
  const creds = await getCredentialsForUser(userId);
  const now = new Date();
  const normalizedButtons = (buttons || []).map((button) => ({
    id: String(button?.id || "").trim(),
    title: String(button?.title || "").trim(),
  }));
  const payload = {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: normalizedButtons.map((button) => ({
          type: "reply",
          reply: button,
        })),
      },
    },
  };
  const message = await Message.create({
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    ...(contactId ? { contactId } : {}),
    phone: to,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    status: "processing",
    sentBy: sentBy || { kind: "system" },
    type: "interactive_buttons",
    text,
    buttons: normalizedButtons,
    payload,
  });

  try {
    const apiResponse = await sendInteractiveButtonMessage({
      accessToken: creds.accessToken,
      phoneNumberId: creds.phoneNumberId,
      to,
      text,
      buttons: normalizedButtons,
      graphApiVersion: creds.graphApiVersion,
    });
    const whatsappMessageId = Array.isArray(apiResponse?.messages)
      ? apiResponse.messages[0]?.id
      : undefined;
    const waId = Array.isArray(apiResponse?.contacts)
      ? apiResponse.contacts[0]?.wa_id
      : undefined;
    const resolvedPhone = waId ? String(waId) : to;
    const sentMessage = await Message.findOneAndUpdate(
      { _id: message._id, workspaceId: userId },
      {
        $set: {
          phone: resolvedPhone,
          whatsappMessageId,
          status: "sent",
          "statusTimestamps.acceptedAt": now,
          "statusTimestamps.sentAt": now,
          sentAt: now,
          sortAt: now,
        },
        $unset: { error: 1 },
      },
      { new: true }
    );

    const conversation = await touchConversation({
      userId,
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      phone: resolvedPhone,
      lastMessageAt: now,
      lastMessagePreview: text,
      incrementUnread: false,
    });
    await touchContactFromMessage({
      userId,
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      phone: resolvedPhone,
      direction: "outbound",
      preview: text,
      occurredAt: now,
    });
    if (conversation) {
      await Message.updateOne(
        { _id: message._id },
        {
          $set: {
            lastAssignedEmployeeId: conversation.assignedEmployeeId || null,
            lastAssignedAt: conversation.assignedAt || null,
            leadStatusSnapshot: conversation.leadStatus || null,
          },
        }
      ).catch(() => {});
    }
    return { message: sentMessage, apiResponse };
  } catch (error) {
    const failure = outboundFailure(error);
    await Message.updateOne(
      { _id: message._id, workspaceId: userId },
      {
        $set: {
          status: "failed",
          "statusTimestamps.failedAt": new Date(),
          error: failure,
        },
      }
    ).catch(() => {});
    error.outboundMessageId = message._id;
    error.outboundFailure = failure;
    try {
      throwIfPhoneNotRegistered(error);
    } catch (normalizedError) {
      normalizedError.outboundMessageId = message._id;
      normalizedError.outboundFailure = failure;
      throw normalizedError;
    }
    throw error;
  }
}

async function sendInteractiveButtonsMessage({
  workspaceId,
  contactId,
  conversationId,
  to,
  text,
  buttons,
  source = "automation",
  flowSessionId,
  flowId,
  nodeId,
  triggeredByMessageId,
  businessInitiated = false,
}) {
  void conversationId;
  void flowSessionId;
  void flowId;
  void nodeId;
  void businessInitiated;
  const bodyText = String(text || "").trim();
  const normalizedButtons = (buttons || [])
    .slice(0, 3)
    .map((button) => ({
      id: String(button?.id || "").trim(),
      title: String(button?.title || "").trim(),
    }));
  const ids = normalizedButtons.map((button) => button.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (!workspaceId || !to || !bodyText) {
    return { success: false, reason: "invalid_interactive_button_input" };
  }
  if (
    normalizedButtons.length === 0 ||
    normalizedButtons.some((button) => !button.id || !button.title) ||
    duplicateIds.length
  ) {
    return {
      success: false,
      reason: "invalid_interactive_buttons",
    };
  }

  try {
    const result = await sendInteractiveButtonMessageForUser({
      userId: workspaceId,
      contactId,
      to,
      text: bodyText,
      buttons: normalizedButtons,
      sentBy: { kind: "system" },
      source,
      senderType: source === "automation" ? "automation" : "business",
      triggeredByMessageId,
    });
    return {
      success: true,
      providerMessageId: result.message?.whatsappMessageId || null,
      outboundMessageId: result.message?._id ? String(result.message._id) : null,
      message: result.message,
      apiResponse: result.apiResponse,
    };
  } catch (error) {
    return {
      success: false,
      reason: expectedOutboundFailure(error).reason,
      metaError: error?.outboundFailure?.meta || error?.metaDebug?.meta || null,
      walletError:
        Number(error?.statusCode || error?.status) === 402
          ? String(error?.message || "Insufficient wallet balance")
          : null,
      outboundMessageId: error?.outboundMessageId
        ? String(error.outboundMessageId)
        : null,
      error,
    };
  }
}

async function sendMediaMessageForUser({
  userId,
  campaignId,
  to,
  type,
  mediaId,
  link,
  caption,
  filename,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
}) {
  const creds = await getCredentialsForUser(userId);
  const normalizedType = String(type || "").toLowerCase();
  let apiResponse;
  try {
    apiResponse = await sendMediaMessage({
      accessToken: creds.accessToken,
      phoneNumberId: creds.phoneNumberId,
      to,
      type: normalizedType,
      mediaId,
      link,
      caption,
      filename,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throwIfPhoneNotRegistered(err);
    throw err;
  }

  const waMessageId = Array.isArray(apiResponse?.messages) ? apiResponse.messages[0]?.id : undefined;
  const waId = Array.isArray(apiResponse?.contacts) ? apiResponse.contacts[0]?.wa_id : undefined;
  const resolvedPhone = waId ? String(waId) : to;
  const now = new Date();

  const payload = {
    to,
    type: normalizedType,
    ...(normalizedType === "image" ? { image: { id: mediaId || null, link: link || null, caption: caption || "" } } : {}),
    ...(normalizedType === "video" ? { video: { id: mediaId || null, link: link || null, caption: caption || "" } } : {}),
    ...(normalizedType === "audio" ? { audio: { id: mediaId || null, link: link || null } } : {}),
    ...(normalizedType === "document"
      ? { document: { id: mediaId || null, link: link || null, caption: caption || "", filename: filename || null } }
      : {}),
  };

  const message = await Message.create({
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    ...(campaignId ? { campaignId } : {}),
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    type: normalizedType,
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "owner" },
    // Don't store bracket placeholders like "[audio]" in UI; let the UI render by payload type.
    text: caption ? String(caption).slice(0, 160) : "",
    payload,
  });

  const conversation = await touchConversation({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    lastMessageAt: now,
    lastMessagePreview: message.text || mediaPreview,
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    direction: "outbound",
    preview: message.text || mediaPreview,
    occurredAt: now,
  });
  if (conversation) {
    const patch = { lastEmployeeReplyAt: now };
    if (!conversation.firstResponseAt && conversation.lastCustomerMessageAt) {
      patch.firstResponseAt = now;
      patch.firstResponseDurationMs = Math.max(0, now.getTime() - new Date(conversation.lastCustomerMessageAt).getTime());
    }
    await Conversation.updateOne({ _id: conversation._id }, { $set: patch }).catch(() => {});
  }
  if (conversation) {
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          lastAssignedEmployeeId: conversation.assignedEmployeeId || null,
          lastAssignedAt: conversation.assignedAt || null,
          leadStatusSnapshot: conversation.leadStatus || null,
        },
      }
    ).catch(() => {});
  }

  if (campaignId) {
    try {
      await Campaign.updateOne(
        { _id: campaignId, workspaceId: userId, status: { $in: ["draft", "queued"] } },
        { $set: { status: "running" } }
      );
    } catch {}
  }

  return { message, apiResponse };
}

module.exports = {
  sendTemplateMessageForUser,
  sendTextMessageForUser,
  sendInteractiveButtonMessageForUser,
  sendInteractiveButtonsMessage,
  sendInteractiveListMessageForUser,
  sendMediaMessageForUser,
};

