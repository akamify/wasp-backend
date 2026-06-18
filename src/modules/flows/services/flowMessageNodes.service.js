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
const mediaAssetRepository = require("@modules/media/repositories/mediaAsset.repository");
const {
  maskedUrlLog,
  validatePublicMediaUrl,
} = require("@shared/utils/mediaValidation");

function plainText(value) {
  return String(value || "").trim();
}

function normalizeListSections(sections) {
  return (sections || []).map((section) => ({
    title: plainText(section?.title),
    rows: (section?.rows || []).map((row) => ({
      id: plainText(row?.id),
      title: plainText(row?.title),
      ...(plainText(row?.description)
        ? { description: plainText(row.description) }
        : {}),
    })),
  }));
}

function normalizeReplyButtons(buttons) {
  const normalized = (buttons || []).slice(0, 3).map((button) => ({
    id: plainText(button?.id),
    title: plainText(button?.title),
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

function isEmptyValue(value) {
  return value === null || value === undefined || value === "";
}

function valueFromTemplateMapping(mapping, scope) {
  const sourceType = String(mapping?.sourceType || mapping?.type || "").trim();
  const sourceKey = String(mapping?.sourceKey || "").trim();
  let value;

  if (sourceType === "static" || sourceType === "literal") {
    value = mapping?.value ?? mapping?.staticValue ?? mapping?.sourceKey ?? "";
  } else if (sourceType === "contact_field") {
    value = sourceKey ? scope.contact?.[sourceKey] : "";
  } else if (sourceType === "contact_attribute") {
    value = sourceKey ? scope.attributes?.[sourceKey] : "";
  } else if (sourceType === "api_context" || sourceType === "context") {
    value = sourceKey ? scope.context?.[sourceKey] : "";
  } else if (sourceType === "workspace_field" || sourceType === "workspace") {
    value = sourceKey ? scope.workspace?.[sourceKey] : "";
  } else {
    value = mapping?.value ?? "";
  }

  const fallback = mapping?.fallback ?? mapping?.fallbackValue ?? "";
  const usedFallback = isEmptyValue(value) && !isEmptyValue(fallback);
  return {
    value: String(usedFallback ? fallback : value ?? ""),
    sourceType,
    usedFallback,
    hasValue: !isEmptyValue(value),
  };
}

function logTemplateVariableResolved({
  node,
  templateName,
  componentType,
  index,
  sourceType,
  hasValue,
  usedFallback,
}) {
  process.stdout.write(
    `[FLOW_TEMPLATE_VARIABLE_RESOLVED] ${JSON.stringify({
      nodeId: node?.id || null,
      templateName,
      componentType,
      index,
      sourceType,
      hasValue,
      usedFallback,
    })}\n`
  );
}

function normalizeTemplateComponents(config) {
  if (Array.isArray(config.templateConfig?.components)) {
    return config.templateConfig.components;
  }
  if (Array.isArray(config.components)) return config.components;
  return [];
}

function resolveTemplateRuntimeValues({ config, scope, node, templateName }) {
  const variables = [];
  const headerVariables = [];
  const buttonValues = [];
  const components = normalizeTemplateComponents(config);

  for (const component of components) {
    const componentType = String(component?.type || "").toLowerCase();
    const mappings = Array.isArray(component?.variables)
      ? component.variables
      : [];
    for (const mapping of mappings) {
      const result = valueFromTemplateMapping(mapping, scope);
      const index = Math.max(1, Number(mapping?.index || 1));
      logTemplateVariableResolved({
        node,
        templateName,
        componentType,
        index,
        sourceType: result.sourceType,
        hasValue: result.hasValue,
        usedFallback: result.usedFallback,
      });
      if (componentType === "header") {
        headerVariables[index - 1] = result.value;
      } else if (
        componentType === "button" ||
        componentType === "button_url" ||
        componentType === "buttons"
      ) {
        const buttonIndex = Math.max(0, Number(mapping?.buttonIndex || 0));
        buttonValues[buttonIndex] = result.value;
      } else {
        variables[index - 1] = result.value;
      }
    }
  }

  if (variables.length || headerVariables.length || buttonValues.length) {
    return {
      variables: variables.map((value) => String(value || "")),
      headerVariables: headerVariables.map((value) => String(value || "")),
      buttonValues: buttonValues.map((value) => String(value || "")),
    };
  }

  const mappings = Array.isArray(config.variableMappings)
    ? config.variableMappings
    : [];
  if (!mappings.length) {
    return {
      variables: (config.variables || []).map((value) =>
        String(resolveVariables(value, scope))
      ),
      headerVariables: [],
      buttonValues: [],
    };
  }
  return {
    variables: mappings
    .slice()
    .sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0))
    .map((mapping) => {
      const fallback = mapping?.fallbackValue ?? "";
      const sourceType = String(mapping?.sourceType || "").trim();
      const sourceKey = String(mapping?.sourceKey || "").trim();
      const expression = sourceKey
        ? sourceType === "static"
          ? String(mapping?.staticValue ?? sourceKey)
          : `{{${sourceType === "contact_attribute" ? "attributes" : sourceType === "contact_field" ? "contact" : sourceType === "api_context" ? "context" : sourceType}.${sourceKey}}}`
        : fallback;
      const resolved = resolveVariables(expression, scope);
      return String(resolved || fallback || "");
    }),
    headerVariables: [],
    buttonValues: [],
  };
}

async function sendTextButtonsNode({
  workspaceId,
  contact,
  session,
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
    text: plainText(config.text),
    buttons: normalizeReplyButtons(config.buttons),
    source: "automation",
    flowSessionId: session?._id || null,
    flowId: session?.flowId || null,
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

function flowLog(label, data) {
  process.stdout.write(`${label} ${JSON.stringify(data)}\n`);
}

async function resolveMediaSource({ workspaceId, contact, session, node }) {
  const config = node.config || {};
  const sourceType = String(config.sourceType || (config.mediaAssetId ? "upload" : "url")).trim();
  const mediaType = String(config.mediaType || "").trim().toLowerCase();
  let resolvedUrl = "";
  let asset = null;

  if (sourceType === "upload" || sourceType === "library") {
    const mediaAssetId = plainText(config.mediaAssetId);
    if (!mediaAssetId) {
      throw new HttpError(400, "Media asset is required", {
        code: "MEDIA_ASSET_NOT_FOUND",
      });
    }
    asset = await mediaAssetRepository.findMediaAssetById({
      workspaceId,
      mediaAssetId,
    });
    if (!asset) {
      throw new HttpError(404, "Media asset not found", {
        code: "MEDIA_ASSET_NOT_FOUND",
      });
    }
    if (asset.mediaType !== mediaType) {
      throw new HttpError(400, "Media asset type does not match node media type", {
        code: "MEDIA_TYPE_NOT_SUPPORTED",
      });
    }
    resolvedUrl = asset.publicUrl;
  } else if (sourceType === "url") {
    resolvedUrl = config.url || config.mediaUrl;
  } else if (sourceType === "api_context") {
    const key = plainText(config.sourceKey);
    resolvedUrl = key ? session?.context?.[key] : "";
    if (!resolvedUrl) {
      flowLog("[FLOW_MEDIA_DYNAMIC_SOURCE_MISSING]", {
        sessionId: session?._id ? String(session._id) : null,
        nodeId: node.id,
        mediaType,
        sourceType,
        sourceKey: key,
      });
      throw new HttpError(400, "Dynamic media source is missing", {
        code: "FLOW_MEDIA_DYNAMIC_SOURCE_MISSING",
      });
    }
  } else if (sourceType === "contact_attribute") {
    const key = plainText(config.sourceKey);
    resolvedUrl = key ? contact?.attributes?.[key] : "";
    if (!resolvedUrl) {
      throw new HttpError(400, "Contact attribute media source is missing", {
        code: "FLOW_MEDIA_DYNAMIC_SOURCE_MISSING",
      });
    }
  } else {
    throw new HttpError(400, "Unsupported media source type", {
      code: "MEDIA_SOURCE_TYPE_INVALID",
    });
  }

  const safeUrl = validatePublicMediaUrl(resolvedUrl);
  flowLog("[FLOW_MEDIA_SOURCE_RESOLVED]", {
    sessionId: session?._id ? String(session._id) : null,
    nodeId: node.id,
    mediaType,
    sourceType,
    hasUrl: Boolean(safeUrl),
    mediaAssetId: asset?._id ? String(asset._id) : null,
    url: maskedUrlLog(safeUrl),
  });
  return {
    mediaType,
    sourceType,
    url: safeUrl,
    asset,
  };
}

async function sendListNode({
  workspaceId,
  contact,
  session,
  node,
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
    contactId: contact._id,
    to: contact.phone,
    text: plainText(config.text),
    buttonText: plainText(config.buttonText),
    sections: normalizeListSections(config.sections),
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
    flowSessionId: session?._id || null,
    flowId: session?.flowId || null,
    nodeId: node.id,
  });
}

async function sendMediaNode({
  workspaceId,
  contact,
  session,
  node,
  businessInitiated = false,
  inboundMessage = null,
}) {
  const config = node.config || {};
  assertFreeformSendAllowed({
    contact,
    sendType: `media_${config.mediaType || "unknown"}`,
    businessInitiated,
  });
  const source = await resolveMediaSource({ workspaceId, contact, session, node });
  flowLog("[FLOW_MEDIA_SEND_START]", {
    sessionId: session?._id ? String(session._id) : null,
    nodeId: node.id,
    mediaType: source.mediaType,
    sourceType: source.sourceType,
  });
  await sendMediaMessageForUser({
    userId: workspaceId,
    contactId: contact._id,
    to: contact.phone,
    type: source.mediaType,
    link: source.url,
    caption: plainText(config.caption),
    filename: plainText(config.filename) || source.asset?.originalName || "",
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
    flowSessionId: session?._id || null,
    flowId: session?.flowId || null,
    nodeId: node.id,
  });
  flowLog("[FLOW_MEDIA_SEND_SUCCESS]", {
    sessionId: session?._id ? String(session._id) : null,
    nodeId: node.id,
    mediaType: source.mediaType,
  });
  return source;
}

async function sendTemplateNode({
  workspaceId,
  contact,
  session,
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

  const resolvedTemplate = resolveTemplateRuntimeValues({
    config,
    scope,
    node,
    templateName,
  });
  process.stdout.write(
    `[FLOW_TEMPLATE_VARIABLES_RESOLVED] ${JSON.stringify({
      nodeId: node.id,
      templateName,
      variablesCount: resolvedTemplate.variables.length,
      headerVariablesCount: resolvedTemplate.headerVariables.length,
      buttonValuesCount: resolvedTemplate.buttonValues.length,
    })}\n`
  );
  await sendTemplateMessageForUser({
    userId: workspaceId,
    contactId: contact._id,
    template,
    to: contact.phone,
    languageCode,
    variables: resolvedTemplate.variables,
    headerVariables: resolvedTemplate.headerVariables,
    buttonValues: resolvedTemplate.buttonValues,
    sentBy: { kind: "system" },
    source: "automation",
    senderType: "automation",
    triggeredByMessageId: inboundMessage?.whatsappMessageId || null,
    flowSessionId: session?._id || null,
    flowId: session?.flowId || null,
    nodeId: node.id,
  });
}

async function testMediaNodeSource({
  workspaceId,
  nodeId,
  config,
  sampleContext = {},
  sampleContact = {},
  sampleAttributes = {},
}) {
  const node = {
    id: nodeId || "test_media_node",
    type: "media",
    config: config || {},
  };
  const session = {
    _id: null,
    context: sampleContext || {},
  };
  const contact = {
    ...(sampleContact || {}),
    attributes: sampleAttributes || sampleContact?.attributes || {},
  };

  try {
    const source = await resolveMediaSource({
      workspaceId,
      contact,
      session,
      node,
    });
    return {
      ok: true,
      mediaType: source.mediaType,
      sourceType: source.sourceType,
      resolvedUrl: source.url,
      fileInfo: {
        mimeType: source.asset?.mimeType || null,
        sizeBytes: source.asset?.sizeBytes || null,
        filename:
          source.asset?.originalName ||
          plainText(config?.filename) ||
          null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      code:
        error?.details?.code ||
        error?.code ||
        "MEDIA_VALIDATION_FAILED",
      message: String(error?.message || "Media validation failed"),
    };
  }
}

module.exports = {
  sendTextButtonsNode,
  sendListNode,
  sendMediaNode,
  sendTemplateNode,
  resolveMediaSource,
  resolveTemplateRuntimeValues,
  testMediaNodeSource,
};
