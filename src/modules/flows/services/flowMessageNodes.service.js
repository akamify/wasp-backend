const { HttpError } = require("@shared/utils/httpError");
const {
  sendInteractiveButtonsMessage,
  sendInteractiveListMessageForUser,
  sendMediaMessageForUser,
  sendTemplateMessageForUser,
} = require("@shared/services/outboundMessageService");
const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const {
  resolveVariables,
} = require("@modules/flows/services/flowRuntime.utils");
const {
  assertFreeformSendAllowed,
} = require("@shared/services/whatsappCustomerWindow");

function normalizeListSections(sections, scope) {
  return (sections || []).map((section) => ({
    title: String(resolveVariables(section?.title || "", scope)).trim(),
    rows: (section?.rows || []).map((row) => ({
      id: String(row?.id || "").trim(),
      title: String(resolveVariables(row?.title || "", scope)).trim(),
      ...(String(resolveVariables(row?.description || "", scope)).trim()
        ? {
            description: String(
              resolveVariables(row.description, scope)
            ).trim(),
          }
        : {}),
    })),
  }));
}

function normalizeReplyButtons(buttons, scope) {
  const normalized = (buttons || []).slice(0, 3).map((button) => ({
    id: String(button?.id || "").trim(),
    title: String(resolveVariables(button?.title || "", scope)).trim(),
  }));
  const seen = new Set();
  for (const button of normalized) {
    if (!button.id || !button.title) {
      throw new HttpError(400, "Reply button id and title are required");
    }
    if (seen.has(button.id)) {
      throw new HttpError(400, "Reply button ids must be unique");
    }
    seen.add(button.id);
  }
  return normalized;
}

async function sendTextButtonsNode({
  workspaceId,
  contact,
  node,
  scope,
  businessInitiated = false,
  inboundMessage = null,
}) {
  const config = node.config || {};
  assertFreeformSendAllowed({
    contact,
    sendType: "interactive_buttons",
    businessInitiated,
  });
  const result = await sendInteractiveButtonsMessage({
    workspaceId,
    contactId: contact._id,
    to: contact.phone,
    text: String(resolveVariables(config.text, scope)).trim(),
    buttons: normalizeReplyButtons(config.buttons, scope),
    source: "automation",
    nodeId: node.id,
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
    businessInitiated,
  });
  if (!result.success) {
    const error = new Error(result.reason || "Interactive button send failed");
    error.outboundFailure = {
      message: result.reason || "Interactive button send failed",
      meta: result.metaError || null,
      walletError: result.walletError || null,
    };
    error.outboundMessageId = result.outboundMessageId || null;
    throw error;
  }
  return result;
}

function resolveHttpUrl(value, scope) {
  const resolved = String(resolveVariables(value, scope)).trim();
  let parsed;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new HttpError(400, "Resolved media URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "Media URL must use http or https");
  }
  return parsed.toString();
}

async function sendListNode({
  workspaceId,
  contact,
  node,
  scope,
  businessInitiated = false,
  inboundMessage = null,
}) {
  const config = node.config || {};
  assertFreeformSendAllowed({
    contact,
    sendType: "interactive_list",
    businessInitiated,
  });
  await sendInteractiveListMessageForUser({
    userId: workspaceId,
    to: contact.phone,
    text: String(resolveVariables(config.text, scope)).trim(),
    buttonText: String(resolveVariables(config.buttonText, scope)).trim(),
    sections: normalizeListSections(config.sections, scope),
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
  });
}

async function sendMediaNode({
  workspaceId,
  contact,
  node,
  scope,
  businessInitiated = false,
  inboundMessage = null,
}) {
  const config = node.config || {};
  assertFreeformSendAllowed({
    contact,
    sendType: `media_${config.mediaType || "unknown"}`,
    businessInitiated,
  });
  await sendMediaMessageForUser({
    userId: workspaceId,
    to: contact.phone,
    type: config.mediaType,
    link: resolveHttpUrl(config.mediaUrl, scope),
    caption: String(resolveVariables(config.caption || "", scope)).trim(),
    filename: String(resolveVariables(config.filename || "", scope)).trim(),
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
  });
}

async function sendTemplateNode({
  workspaceId,
  contact,
  node,
  scope,
  inboundMessage = null,
}) {
  const config = node.config || {};
  const templateName = String(config.templateName || "").trim();
  const languageCode = String(config.languageCode || "").trim();
  const template = await flowSessionRepository.findApprovedTemplate({
    workspaceId,
    wabaId: contact.wabaId,
    name: templateName,
    languageCode,
  });
  if (!template) {
    throw new HttpError(
      409,
      `Approved template '${templateName}' (${languageCode}) was not found for the active WhatsApp account`
    );
  }

  const variables = (config.variables || []).map((value) =>
    String(resolveVariables(value, scope))
  );
  await sendTemplateMessageForUser({
    userId: workspaceId,
    contactId: contact._id,
    template,
    to: contact.phone,
    languageCode,
    variables,
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
  });
}

module.exports = {
  sendTextButtonsNode,
  sendListNode,
  sendMediaNode,
  sendTemplateNode,
};
