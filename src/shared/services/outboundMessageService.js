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
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { publishToWorkspace } = require("@shared/services/realtimeService");
const {
  reserveTemplateCharge,
  releaseTemplateCharge,
  finalizeTemplateCharge,
} = require("@modules/wallet/services/wallet.core.service");
const {
  META_BILLING_OWNER,
  META_BILLING_HANDLED_BY,
  MESSAGE_CHARGE_SOURCE,
} = require("@shared/constants/messageBilling");

async function persistTemplateFailure({ userId, messageId, template, to, campaignId, campaignRunId, source, error, charge }) {
  const failureCode = error?.details?.code || (Number(error?.statusCode || error?.status) === 402 ? "INSUFFICIENT_WALLET_BALANCE" : "TEMPLATE_SEND_FAILED");
  const failureMessage = error?.details?.userMessage || error?.message || "Template send failed";
  const data = {
    workspaceId: userId,
    ...(campaignId ? { campaignId } : {}),
    ...(campaignRunId ? { campaignRunId } : {}),
    templateId: template?._id || null,
    phone: to,
    direction: "outbound",
    type: "template",
    status: "failed",
    statusTimestamps: { failedAt: new Date() },
    messageKind: campaignId ? "campaign" : source === "automation" ? "automation" : "template",
    chargeAmount: 0,
    chargeCategory: charge?.category || String(template?.category || "unknown").toLowerCase(),
    platformWalletCharged: false,
    chargeSource: charge?.chargeSource || MESSAGE_CHARGE_SOURCE.NONE,
    metaBillingHandledBy: META_BILLING_HANDLED_BY,
    sendFailureCode: failureCode,
    sendFailureMessage: failureMessage,
    error: { code: failureCode, message: failureMessage },
  };
  if (messageId) await Message.updateOne({ _id: messageId, workspaceId: userId }, { $set: data });
  else await Message.create(data);
  error.templateFailurePersisted = true;
}

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
  flowSessionId,
  flowId,
  nodeId,
}) {
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

  const creds = await getCredentialsForUser(userId);
  assertTemplateBelongsToWaba(template, creds.wabaId);

  let charge;
  try {
    charge = await reserveTemplateCharge(userId, template.category, {
      templateId: template?._id ? String(template._id) : null,
      campaignId: campaignId ? String(campaignId) : null,
      campaignRunId: campaignRunId ? String(campaignRunId) : null,
      to,
    });
  } catch (error) {
    await persistTemplateFailure({ userId, messageId, template, to, campaignId, campaignRunId, source, error, charge: null }).catch(() => {});
    throw error;
  }

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
    await releaseTemplateCharge(userId, charge).catch(() => {});
    if (!messageId) {
      await persistTemplateFailure({ userId, messageId, template, to, campaignId, campaignRunId, source, error: err, charge }).catch(() => {});
    }
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
    ...(flowSessionId ? { flowSessionId } : {}),
    ...(flowId ? { flowId } : {}),
    ...(nodeId ? { nodeId } : {}),
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "owner" },
    text: previewText,
    displayText: previewText,
    previewText,
    type: "template",
    messageKind: campaignId ? "campaign" : source === "automation" ? "automation" : "template",
    chargeAmount: 0,
    chargeCategory: charge.category,
    platformWalletCharged: false,
    chargeSource: charge.chargeSource,
    metaBillingHandledBy: META_BILLING_HANDLED_BY,
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
        { returnDocument: "after" }
      )
    : await Message.create(messageData);
  if (!message) throw new Error("Outbound message reservation not found");

  const finalizedCharge = await finalizeTemplateCharge(userId, charge, {
    workspaceId: String(userId),
    messageId: String(message._id),
    wamid: waMessageId || null,
    category: charge.category,
  });
  if (finalizedCharge.charged) {
    message.chargeAmount = finalizedCharge.amount;
    message.platformWalletCharged = true;
    message.chargeSource = MESSAGE_CHARGE_SOURCE.WALLET;
    message.walletTransactionId = finalizedCharge.transaction?._id || null;
    await message.save();
  }

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

  return {
    message,
    apiResponse,
    billing: {
      metaBillingOwner: META_BILLING_OWNER,
      platformWalletCharged: Boolean(message.platformWalletCharged),
      messageChargeSource: message.chargeSource,
    },
  };
}

async function sendTextMessageForUser({
  userId,
  contactId,
  to,
  text,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
  flowSessionId,
  flowId,
  nodeId,
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
    ...(contactId ? { contactId } : {}),
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    ...(flowSessionId ? { flowSessionId } : {}),
    ...(flowId ? { flowId } : {}),
    ...(nodeId ? { nodeId } : {}),
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "owner" },
    text,
    displayText: text,
    previewText: text,
    type: "text",
    payload: { to, text },
    messageKind: source === "automation" ? "automation" : "service",
    chargeAmount: 0,
    chargeCategory: null,
    platformWalletCharged: false,
    chargeSource: MESSAGE_CHARGE_SOURCE.FREE_SERVICE_WINDOW,
    metaBillingHandledBy: META_BILLING_HANDLED_BY,
  });

  const conversation = await touchConversation({ userId, wabaId: creds.wabaId, phoneNumberId: creds.phoneNumberId, phone: resolvedPhone, lastMessageAt: now, lastMessagePreview: text, incrementUnread: false });
  await WhatsAppCredentials.updateOne(
    { workspaceId: userId, isActive: { $ne: false } },
    { $set: { lastSuccessfulSendAt: now } }
  ).catch(() => {});
  publishToWorkspace(userId, "message:new", {
    conversationId: conversation?._id ? String(conversation._id) : null,
    customerPhone: resolvedPhone,
    message: message.toObject ? message.toObject() : message,
  });
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

  return {
    message,
    apiResponse,
    billing: {
      metaBillingOwner: META_BILLING_OWNER,
      platformWalletCharged: false,
      messageChargeSource: MESSAGE_CHARGE_SOURCE.FREE_SERVICE_WINDOW,
    },
  };
}

async function sendInteractiveListMessageForUser({
  userId,
  contactId,
  to,
  text,
  buttonText,
  sections,
  sentBy,
  source,
  senderType,
  triggeredByMessageId,
  flowSessionId,
  flowId,
  nodeId,
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
    ...(contactId ? { contactId } : {}),
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    ...(flowSessionId ? { flowSessionId } : {}),
    ...(flowId ? { flowId } : {}),
    ...(nodeId ? { nodeId } : {}),
    type: "interactive_list",
    whatsappMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "system" },
    text,
    displayText: text,
    previewText: text,
    interactive: {
      type: "list",
      buttonText,
      sections,
    },
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
  return {
    message,
    apiResponse,
    billing: {
      metaBillingOwner: META_BILLING_OWNER,
      platformWalletCharged: false,
      messageChargeSource: MESSAGE_CHARGE_SOURCE.FREE_SERVICE_WINDOW,
    },
  };
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
  flowSessionId,
  flowId,
  nodeId,
}) {
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
  const creds = await getCredentialsForUser(userId);
  const now = new Date();
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
    ...(flowSessionId ? { flowSessionId } : {}),
    ...(flowId ? { flowId } : {}),
    ...(nodeId ? { nodeId } : {}),
    status: "processing",
    sentBy: sentBy || { kind: "system" },
    type: "interactive_buttons",
    text,
    displayText: text,
    previewText: text,
    buttons: normalizedButtons,
    interactive: {
      type: "button",
      buttons: normalizedButtons,
    },
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
      { returnDocument: "after" }
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
      flowSessionId,
      flowId,
      nodeId,
    });
    return {
      ok: true,
      success: true,
      status: result.status || "sent",
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
  contactId,
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
  flowSessionId,
  flowId,
  nodeId,
}) {
  const normalizedType = String(type || "").toLowerCase();
  const creds = await getCredentialsForUser(userId);
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
  const mediaPreview =
    normalizedType === "document"
      ? String(filename || "Document")
      : normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1);

  const message = await Message.create({
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    ...(campaignId ? { campaignId } : {}),
    ...(contactId ? { contactId } : {}),
    phone: resolvedPhone,
    direction: "outbound",
    source,
    senderType,
    triggeredByMessageId,
    ...(flowSessionId ? { flowSessionId } : {}),
    ...(flowId ? { flowId } : {}),
    ...(nodeId ? { nodeId } : {}),
    type: normalizedType,
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    sentAt: now,
    sortAt: now,
    sentBy: sentBy || { kind: "owner" },
    // Don't store bracket placeholders like "[audio]" in UI; let the UI render by payload type.
    text: caption ? String(caption).slice(0, 160) : "",
    displayText: caption ? String(caption).slice(0, 160) : mediaPreview,
    previewText: caption ? String(caption).slice(0, 160) : mediaPreview,
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

