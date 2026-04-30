const { Message } = require("../models/Message");
const { getCredentialsForUser } = require("./credentialsService");
const { sendTemplateMessage, sendTextMessage } = require("../utils/whatsappSender");
const { touchConversation } = require("./conversationService");
const { touchContactFromMessage } = require("./contactService");
const {
  buildComponentsFromTemplate,
  normalizeTemplate,
  renderTemplatePreview,
} = require("../utils/templateStructure");

async function sendTemplateMessageForUser({
  userId,
  template,
  to,
  languageCode,
  variables,
  headerVariables,
  otpCode,
  buttonValues,
}) {
  const creds = await getCredentialsForUser(userId);
  const normalizedTemplate = normalizeTemplate(template.toObject ? template.toObject() : template);
  const sendComponents = buildComponentsFromTemplate(normalizedTemplate, {
    variables,
    headerVariables,
    otpCode,
    buttonValues,
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

  const now = new Date();

  const message = await Message.create({
    workspaceId: userId,
    templateId: normalizedTemplate._id,
    phone: to,
    direction: "outbound",
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { sentAt: now },
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
      },
      components: sendComponents,
    },
  });

  await touchConversation({
    userId,
    phone: to,
    lastMessageAt: now,
    lastMessagePreview: previewText,
    incrementUnread: false,
  });
  await touchContactFromMessage({
    userId,
    phone: to,
    direction: "outbound",
    preview: previewText,
    occurredAt: now,
  });

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
  const now = new Date();

  const message = await Message.create({
    workspaceId: userId,
    phone: to,
    direction: "outbound",
    whatsappMessageId: waMessageId,
    status: "sent",
    statusTimestamps: { sentAt: now },
    text,
    payload: { to, text },
  });

  await touchConversation({ userId, phone: to, lastMessageAt: now, lastMessagePreview: text, incrementUnread: false });
  await touchContactFromMessage({ userId, phone: to, direction: "outbound", preview: text, occurredAt: now });

  return { message, apiResponse };
}

module.exports = { sendTemplateMessageForUser, sendTextMessageForUser };
