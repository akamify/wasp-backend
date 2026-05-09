const { Message } = require("../models/Message");
const { getCredentialsForUser } = require("./credentialsService");
const { sendTemplateMessage, sendTextMessage, sendMediaMessage } = require("../utils/whatsappSender");
const { touchConversation } = require("./conversationService");
const { touchContactFromMessage } = require("./contactService");
const { Campaign } = require("../models/Campaign");
const {
  buildComponentsFromTemplate,
  normalizeTemplate,
  renderTemplatePreview,
} = require("../utils/templateStructure");

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
}) {
  const creds = await getCredentialsForUser(userId);
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

  const apiResponse = await sendTemplateMessage({
    accessToken: creds.accessToken,
    phoneNumberId: creds.phoneNumberId,
    to,
    templateName: normalizedTemplate.name,
    languageCode: languageCode || normalizedTemplate.language,
    components: sendComponents,
    graphApiVersion: creds.graphApiVersion,
  });

  const waMessageId = Array.isArray(apiResponse?.messages)
    ? apiResponse.messages[0]?.id
    : undefined;
  const waId = Array.isArray(apiResponse?.contacts) ? apiResponse.contacts[0]?.wa_id : undefined;
  const resolvedPhone = waId ? String(waId) : to;

  const now = new Date();

  const message = await Message.create({
    workspaceId: userId,
    ...(campaignId ? { campaignId } : {}),
    templateId: normalizedTemplate._id,
    phone: resolvedPhone,
    direction: "outbound",
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    text: previewText,
    payload: {
      to,
      template: {
        name: normalizedTemplate.name,
        language: languageCode || normalizedTemplate.language,
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

  await touchConversation({
    userId,
    phone: resolvedPhone,
    lastMessageAt: now,
    lastMessagePreview: previewText,
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    phone: resolvedPhone,
    direction: "outbound",
    preview: previewText,
    occurredAt: now,
  });

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

async function sendTextMessageForUser({ userId, to, text }) {
  const creds = await getCredentialsForUser(userId);
  const apiResponse = await sendTextMessage({
    accessToken: creds.accessToken,
    phoneNumberId: creds.phoneNumberId,
    to,
    text,
    graphApiVersion: creds.graphApiVersion,
  });

  const waMessageId = Array.isArray(apiResponse?.messages) ? apiResponse.messages[0]?.id : undefined;
  const waId = Array.isArray(apiResponse?.contacts) ? apiResponse.contacts[0]?.wa_id : undefined;
  const resolvedPhone = waId ? String(waId) : to;
  const now = new Date();

  const message = await Message.create({
    workspaceId: userId,
    phone: resolvedPhone,
    direction: "outbound",
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    text,
    payload: { to, text },
  });

  await touchConversation({ userId, phone: resolvedPhone, lastMessageAt: now, lastMessagePreview: text, incrementUnread: false });
  await touchContactFromMessage({ userId, phone: resolvedPhone, direction: "outbound", preview: text, occurredAt: now });

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
}) {
  const creds = await getCredentialsForUser(userId);
  const normalizedType = String(type || "").toLowerCase();
  const apiResponse = await sendMediaMessage({
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
    ...(campaignId ? { campaignId } : {}),
    phone: resolvedPhone,
    direction: "outbound",
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { acceptedAt: now, sentAt: now },
    // Don't store bracket placeholders like "[audio]" in UI; let the UI render by payload type.
    text: caption ? String(caption).slice(0, 160) : "",
    payload,
  });

  await touchConversation({
    userId,
    phone: resolvedPhone,
    lastMessageAt: now,
    lastMessagePreview: message.text || "",
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    phone: resolvedPhone,
    direction: "outbound",
    preview: message.text || "",
    occurredAt: now,
  });

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
