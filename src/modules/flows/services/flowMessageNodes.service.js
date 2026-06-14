const { HttpError } = require("@shared/utils/httpError");
const {
  sendInteractiveListMessageForUser,
  sendMediaMessageForUser,
  sendTemplateMessageForUser,
} = require("@shared/services/outboundMessageService");
const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");
const {
  resolveVariables,
} = require("@modules/flows/services/flowRuntime.utils");

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

async function sendListNode({ workspaceId, contact, node, scope }) {
  const config = node.config || {};
  await sendInteractiveListMessageForUser({
    userId: workspaceId,
    to: contact.phone,
    text: String(resolveVariables(config.text, scope)).trim(),
    buttonText: String(resolveVariables(config.buttonText, scope)).trim(),
    sections: normalizeListSections(config.sections, scope),
    sentBy: { kind: "system" },
  });
}

async function sendMediaNode({ workspaceId, contact, node, scope }) {
  const config = node.config || {};
  await sendMediaMessageForUser({
    userId: workspaceId,
    to: contact.phone,
    type: config.mediaType,
    link: resolveHttpUrl(config.mediaUrl, scope),
    caption: String(resolveVariables(config.caption || "", scope)).trim(),
    filename: String(resolveVariables(config.filename || "", scope)).trim(),
    sentBy: { kind: "system" },
  });
}

async function sendTemplateNode({ workspaceId, contact, node, scope }) {
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
  });
}

module.exports = {
  sendListNode,
  sendMediaNode,
  sendTemplateNode,
};
