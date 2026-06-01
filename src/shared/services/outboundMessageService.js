const { Message } = require("@infra/database/Message");
const { Conversation } = require("@infra/database/Conversation");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { sendTemplateMessage, sendTextMessage, sendMediaMessage } = require("@shared/utils/whatsappSender");
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

async function sendTemplateMessageForUser({
  userId,
  campaignId,
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
}) {
  const creds = await getCredentialsForUser(userId);
  assertTemplateBelongsToWaba(template, creds.wabaId);
  const resolvedLanguageCode = String(languageCode || template?.languageCode || template?.language || "").trim();
  const templateLanguageCode = String(template?.languageCode || template?.language || "").trim();
  if (!templateLanguageCode || resolvedLanguageCode !== templateLanguageCode) {
    // eslint-disable-next-line no-console
    console.warn("[templates] send rejected template not in active WABA", {
      workspaceId: String(userId),
      reason: "language_mismatch",
    });
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

  const message = await Message.create({
    workspaceId: userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    ...(campaignId ? { campaignId } : {}),
    templateId: normalizedTemplate._id,
    phone: resolvedPhone,
    direction: "outbound",
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
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
  });

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

async function sendTextMessageForUser({ userId, to, text, sentBy }) {
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
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
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
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
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
    lastMessagePreview: message.text || "",
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    phone: resolvedPhone,
    direction: "outbound",
    preview: message.text || "",
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

module.exports = { sendTemplateMessageForUser, sendTextMessageForUser, sendMediaMessageForUser };

