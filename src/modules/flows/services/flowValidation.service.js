const VALID_TRIGGER_TYPES = new Set([
  "keyword",
  "template_button",
  "ctwa",
  "manual",
]);
const {
  DEFAULT_FLOW_RUNTIME_SETTINGS,
  normalizeRuntimeSettings,
} = require("@modules/flows/constants/flowRuntimeSettings");
const { validatePublicMediaUrl } = require("@shared/utils/mediaValidation");
const VALID_MATCH_MODES = new Set(["exact", "contains", "regex"]);
const VALID_NODE_TYPES = new Set([
  "start",
  "text",
  "text_buttons",
  "ask_question",
  "list",
  "media",
  "template",
  "set_tag",
  "set_attribute",
  "api_request",
  "request_intervention",
  "end",
]);
const VALID_INPUT_TYPES = new Set(["text", "number", "email", "phone"]);
const VALID_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const VALID_RESPONSE_MAPPING_TYPES = new Set(["string", "number", "boolean", "url", "json"]);
const VALID_MEDIA_TYPES = new Set(["image", "video", "document", "audio"]);
const VALID_MEDIA_SOURCE_TYPES = new Set([
  "upload",
  "library",
  "url",
  "api_context",
  "contact_attribute",
]);
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*[^}]+\s*\}\}/;
const SENSITIVE_TEMPLATE_KEY_PATTERN = /(token|secret|password|apikey|api_key|authorization)/i;
const FORBIDDEN_API_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);
const SENSITIVE_API_CONTEXT_KEY_PATTERN = /(token|secret|password|apikey|api_key|authorization)/i;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(target, code, message, options = {}) {
  target.push({
    code,
    message,
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
    ...(options.field ? { field: options.field } : {}),
  });
}

function validateRuntimeSettings(runtimeSettings, errors) {
  const timeout = Number(
    runtimeSettings?.sessionTimeoutMinutes ??
      DEFAULT_FLOW_RUNTIME_SETTINGS.sessionTimeoutMinutes
  );
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
    addIssue(
      errors,
      "SESSION_TIMEOUT_INVALID",
      "Session timeout must be between 1 and 600 minutes",
      { field: "runtimeSettings.sessionTimeoutMinutes" }
    );
  }
  const normalizedSettings = normalizeRuntimeSettings(runtimeSettings);
  const expiry = runtimeSettings?.onSessionExpired || {};
  if (TEMPLATE_TOKEN_PATTERN.test(String(normalizedSettings.invalidReplyMessage || ""))) {
    addIssue(
      errors,
      "VARIABLES_ONLY_ALLOWED_IN_TEMPLATE",
      "Variables are only supported in WhatsApp Template Message nodes",
      { field: "runtimeSettings.invalidReplyMessage" }
    );
  }
  if (expiry.action === "text" && !isNonEmptyString(expiry.textMessage)) {
    addIssue(errors, "EXPIRY_TEXT_REQUIRED", "Expiry text message is required", {
      field: "runtimeSettings.onSessionExpired.textMessage",
    });
  }
  if (expiry.action === "text" && TEMPLATE_TOKEN_PATTERN.test(String(expiry.textMessage || ""))) {
    addIssue(
      errors,
      "VARIABLES_ONLY_ALLOWED_IN_TEMPLATE",
      "Variables are only supported in WhatsApp Template Message nodes",
      { field: "runtimeSettings.onSessionExpired.textMessage" }
    );
  }
  if (expiry.action === "template") {
    if (!isNonEmptyString(expiry.templateName)) {
      addIssue(
        errors,
        "EXPIRY_TEMPLATE_REQUIRED",
        "Expiry template name is required",
        { field: "runtimeSettings.onSessionExpired.templateName" }
      );
    }
    if (!isNonEmptyString(expiry.languageCode)) {
      addIssue(
        errors,
        "EXPIRY_TEMPLATE_LANGUAGE_REQUIRED",
        "Expiry template language code is required",
        { field: "runtimeSettings.onSessionExpired.languageCode" }
      );
    }
    validateTemplateMappings(
      {
        id: "session_expiry_template",
        config: expiry,
      },
      errors
    );
  }
}

function validateRequiredString({
  errors,
  value,
  code,
  message,
  nodeId,
  field,
}) {
  if (!isNonEmptyString(value)) {
    addIssue(errors, code, message, { nodeId, field });
  }
}

function isValidContextKey(value) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(value || ""));
}

function isVariableSafeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const sample = raw.replace(/\{\{\s*[^}]+\s*\}\}/g, "sample");
  try {
    const parsed = new URL(sample);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isValidJsonString(value) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function hasTemplateToken(value) {
  return TEMPLATE_TOKEN_PATTERN.test(String(value || ""));
}

function addTemplateOnlyVariableError(errors, nodeId, field) {
  addIssue(
    errors,
    "VARIABLES_ONLY_ALLOWED_IN_TEMPLATE",
    "Variables are only supported in WhatsApp Template Message nodes",
    { nodeId, field }
  );
}

function validateNoVariables(errors, nodeId, field, value) {
  if (hasTemplateToken(value)) addTemplateOnlyVariableError(errors, nodeId, field);
}

function validateNoVariablesInList(errors, node) {
  const config = node.config || {};
  validateNoVariables(errors, node.id, "config.text", config.text);
  validateNoVariables(errors, node.id, "config.buttonText", config.buttonText);
  for (const [sectionIndex, section] of (config.sections || []).entries()) {
    validateNoVariables(
      errors,
      node.id,
      `config.sections.${sectionIndex}.title`,
      section?.title
    );
    for (const [rowIndex, row] of (section?.rows || []).entries()) {
      validateNoVariables(
        errors,
        node.id,
        `config.sections.${sectionIndex}.rows.${rowIndex}.title`,
        row?.title
      );
      validateNoVariables(
        errors,
        node.id,
        `config.sections.${sectionIndex}.rows.${rowIndex}.description`,
        row?.description
      );
    }
  }
}

function templateMappingRows(config) {
  const components = Array.isArray(config?.templateConfig?.components)
    ? config.templateConfig.components
    : Array.isArray(config?.components)
      ? config.components
      : [];
  return components.flatMap((component) =>
    Array.isArray(component?.variables) ? component.variables : []
  );
}

function validateTemplateMappings(node, errors) {
  const config = node?.config || {};
  for (const mapping of templateMappingRows(config)) {
    const sourceKey = String(mapping?.sourceKey || mapping?.value || "").trim();
    if (sourceKey && SENSITIVE_TEMPLATE_KEY_PATTERN.test(sourceKey)) {
      addIssue(
        errors,
        "SENSITIVE_VALUE_NOT_ALLOWED_IN_TEMPLATE",
        "Sensitive token, secret, password, API key, or authorization values cannot be mapped to customer-visible template variables",
        { nodeId: node.id, field: "config.templateConfig.components.variables.sourceKey" }
      );
    }
  }
}

function validateTrigger(trigger, errors) {
  if (!trigger || typeof trigger !== "object" || !trigger.type) {
    addIssue(errors, "TRIGGER_REQUIRED", "A flow trigger must be configured", {
      field: "trigger.type",
    });
    return;
  }

  if (!VALID_TRIGGER_TYPES.has(trigger.type)) {
    addIssue(errors, "TRIGGER_TYPE_INVALID", "Trigger type is invalid", {
      field: "trigger.type",
    });
    return;
  }

  if (trigger.type === "keyword") {
    const keywords = trigger.keywords;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      addIssue(
        errors,
        "TRIGGER_KEYWORDS_REQUIRED",
        "Keyword trigger requires at least one keyword",
        { field: "trigger.keywords" }
      );
    } else if (keywords.some((keyword) => !isNonEmptyString(keyword))) {
      addIssue(
        errors,
        "TRIGGER_KEYWORD_INVALID",
        "Keywords must be non-empty strings",
        { field: "trigger.keywords" }
      );
    }
    if (!VALID_MATCH_MODES.has(trigger.matchMode)) {
      addIssue(
        errors,
        "TRIGGER_MATCH_MODE_INVALID",
        "Keyword match mode must be exact, contains, or regex",
        { field: "trigger.matchMode" }
      );
    }
  }

  if (
    trigger.type === "template_button" &&
    (!Array.isArray(trigger.templateButtonPayloads) ||
      !trigger.templateButtonPayloads.some(isNonEmptyString))
  ) {
    addIssue(
      errors,
      "TRIGGER_TEMPLATE_PAYLOAD_REQUIRED",
      "Template button trigger requires at least one payload",
      { field: "trigger.templateButtonPayloads" }
    );
  }

  if (
    trigger.type === "ctwa" &&
    (!Array.isArray(trigger.ctwaPayloads) ||
      !trigger.ctwaPayloads.some(isNonEmptyString))
  ) {
    addIssue(
      errors,
      "TRIGGER_CTWA_PAYLOAD_REQUIRED",
      "CTWA trigger requires at least one payload",
      { field: "trigger.ctwaPayloads" }
    );
  }
}

function validateTextButtonsNode(node, outgoingEdges, fallbackNodeId, errors) {
  const config = node.config || {};
  validateRequiredString({
    errors,
    value: config.text,
    code: "TEXT_BUTTONS_TEXT_REQUIRED",
    message: "Text buttons node requires config.text",
    nodeId: node.id,
    field: "config.text",
  });

  if (!Array.isArray(config.buttons) || config.buttons.length === 0) {
    addIssue(
      errors,
      "TEXT_BUTTONS_REQUIRED",
      "Text buttons node requires at least one button",
      { nodeId: node.id, field: "config.buttons" }
    );
    return;
  }
  if (config.buttons.length > 3) {
    addIssue(
      errors,
      "TEXT_BUTTONS_MAX_EXCEEDED",
      "WhatsApp reply button nodes can have at most 3 buttons",
      { nodeId: node.id, field: "config.buttons" }
    );
  }

  const buttonIds = new Set();
  for (const button of config.buttons) {
    const buttonId = isNonEmptyString(button?.id) ? button.id.trim() : "";
    if (!buttonId) {
      addIssue(errors, "BUTTON_ID_REQUIRED", "Button id is required", {
        nodeId: node.id,
        field: "config.buttons.id",
      });
    } else if (buttonIds.has(buttonId)) {
      addIssue(errors, "BUTTON_ID_DUPLICATE", `Duplicate button id '${buttonId}'`, {
        nodeId: node.id,
        field: "config.buttons.id",
      });
    } else {
      buttonIds.add(buttonId);
    }

    validateRequiredString({
      errors,
      value: button?.title,
      code: "BUTTON_TITLE_REQUIRED",
      message: "Button title is required",
      nodeId: node.id,
      field: "config.buttons.title",
    });

    if (
      buttonId &&
      !fallbackNodeId &&
      !outgoingEdges.some(
        (edge) => String(edge.sourceHandle || "").trim() === buttonId
      )
    ) {
      addIssue(
        errors,
        "BUTTON_EDGE_REQUIRED",
        `Button '${buttonId}' requires a matching outgoing edge`,
        { nodeId: node.id, field: "config.buttons" }
      );
    }
  }
}

function validateListNode(node, errors) {
  const config = node.config || {};
  validateRequiredString({
    errors,
    value: config.text,
    code: "LIST_TEXT_REQUIRED",
    message: "List node requires config.text",
    nodeId: node.id,
    field: "config.text",
  });
  validateRequiredString({
    errors,
    value: config.buttonText,
    code: "LIST_BUTTON_TEXT_REQUIRED",
    message: "List node requires config.buttonText",
    nodeId: node.id,
    field: "config.buttonText",
  });

  if (!Array.isArray(config.sections) || config.sections.length === 0) {
    addIssue(errors, "LIST_SECTIONS_REQUIRED", "List sections are required", {
      nodeId: node.id,
      field: "config.sections",
    });
    return;
  }

  const rowIds = new Set();
  let rowCount = 0;
  for (const section of config.sections) {
    if (!Array.isArray(section?.rows) || section.rows.length === 0) {
      addIssue(
        errors,
        "LIST_ROWS_REQUIRED",
        "Every list section requires at least one row",
        { nodeId: node.id, field: "config.sections.rows" }
      );
      continue;
    }
    for (const row of section.rows) {
      rowCount += 1;
      const rowId = isNonEmptyString(row?.id) ? row.id.trim() : "";
      if (!rowId) {
        addIssue(errors, "LIST_ROW_ID_REQUIRED", "List row id is required", {
          nodeId: node.id,
          field: "config.sections.rows.id",
        });
      } else if (rowIds.has(rowId)) {
        addIssue(
          errors,
          "LIST_ROW_ID_DUPLICATE",
          `Duplicate list row id '${rowId}'`,
          { nodeId: node.id, field: "config.sections.rows.id" }
        );
      } else {
        rowIds.add(rowId);
      }
      if (!isNonEmptyString(row?.title)) {
        addIssue(
          errors,
          "LIST_ROW_TITLE_REQUIRED",
          "List row title is required",
          { nodeId: node.id, field: "config.sections.rows.title" }
        );
      }
    }
  }

  if (rowCount === 0) {
    addIssue(errors, "LIST_ROWS_REQUIRED", "List rows are required", {
      nodeId: node.id,
      field: "config.sections.rows",
    });
  }
}

function validateNode(node, outgoingEdges, fallbackNodeId, errors, warnings) {
  const nodeId = isNonEmptyString(node?.id) ? node.id.trim() : null;
  const config = node?.config || {};

  if (!VALID_NODE_TYPES.has(node?.type)) return;

  if (node.type === "text") {
    validateNoVariables(errors, nodeId, "config.text", config.text);
    validateRequiredString({
      errors,
      value: config.text,
      code: "TEXT_REQUIRED",
      message: "Text node requires config.text",
      nodeId,
      field: "config.text",
    });
  }

  if (node.type === "text_buttons") {
    validateNoVariables(errors, nodeId, "config.text", config.text);
    for (const [index, button] of (config.buttons || []).entries()) {
      validateNoVariables(
        errors,
        nodeId,
        `config.buttons.${index}.title`,
        button?.title
      );
    }
    validateTextButtonsNode(node, outgoingEdges, fallbackNodeId, errors);
  }

  if (node.type === "ask_question") {
    validateNoVariables(errors, nodeId, "config.question", config.question);
    validateRequiredString({
      errors,
      value: config.question,
      code: "QUESTION_REQUIRED",
      message: "Ask question node requires config.question",
      nodeId,
      field: "config.question",
    });
    if (!VALID_INPUT_TYPES.has(config.inputType)) {
      addIssue(
        errors,
        "QUESTION_INPUT_TYPE_INVALID",
        "Question inputType must be text, number, email, or phone",
        { nodeId, field: "config.inputType" }
      );
    }
  }

  if (node.type === "list") {
    validateNoVariablesInList(errors, node);
    validateListNode(node, errors);
  }

  if (node.type === "media") {
    const sourceType = String(
      config.sourceType || (config.mediaAssetId ? "upload" : "url")
    ).trim();
    const staticUrl = config.url || config.mediaUrl;
    validateNoVariables(errors, nodeId, "config.mediaUrl", config.mediaUrl);
    validateNoVariables(errors, nodeId, "config.url", config.url);
    validateNoVariables(errors, nodeId, "config.caption", config.caption);
    validateNoVariables(errors, nodeId, "config.filename", config.filename);
    if (!VALID_MEDIA_TYPES.has(config.mediaType)) {
      addIssue(
        errors,
        "MEDIA_TYPE_INVALID",
        "Media type must be image, video, document, or audio",
        { nodeId, field: "config.mediaType" }
      );
    }
    if (!VALID_MEDIA_SOURCE_TYPES.has(sourceType)) {
      addIssue(
        errors,
        "MEDIA_SOURCE_TYPE_INVALID",
        "Media source type must be upload, library, url, api_context, or contact_attribute",
        { nodeId, field: "config.sourceType" }
      );
    }
    validateRequiredString({
      errors,
      value: config.mediaType,
      code: "MEDIA_TYPE_REQUIRED",
      message: "Media node requires config.mediaType",
      nodeId,
      field: "config.mediaType",
    });
    if (sourceType === "upload" || sourceType === "library") {
      validateRequiredString({
        errors,
        value: config.mediaAssetId,
        code: "MEDIA_ASSET_REQUIRED",
        message: "Upload media source requires a media asset",
        nodeId,
        field: "config.mediaAssetId",
      });
    }
    if (sourceType === "url") {
      validateRequiredString({
        errors,
        value: staticUrl,
        code: "MEDIA_URL_REQUIRED",
        message: "Static URL media source requires a public media URL",
        nodeId,
        field: "config.url",
      });
      if (isNonEmptyString(staticUrl)) {
        try {
          validatePublicMediaUrl(staticUrl);
        } catch (error) {
          addIssue(
            errors,
            error?.details?.code || "MEDIA_URL_INVALID",
            error?.message || "Media URL is not allowed",
            { nodeId, field: "config.url" }
          );
        }
      }
    }
    if (sourceType === "api_context" || sourceType === "contact_attribute") {
      validateRequiredString({
        errors,
        value: config.sourceKey,
        code: "MEDIA_SOURCE_KEY_REQUIRED",
        message: "Dynamic media source requires a source key",
        nodeId,
        field: "config.sourceKey",
      });
    }
    if (
      !outgoingEdges.some(
        (edge) => String(edge.sourceHandle || "").trim().toLowerCase() === "failure"
      )
    ) {
      addIssue(
        warnings,
        "MEDIA_FAILURE_EDGE_RECOMMENDED",
        "Add a failure edge so the flow can continue if media cannot be sent",
        { nodeId, field: "edges" }
      );
    }
  }

  if (node.type === "template") {
    validateRequiredString({
      errors,
      value: config.templateName,
      code: "TEMPLATE_NAME_REQUIRED",
      message: "Template node requires config.templateName",
      nodeId,
      field: "config.templateName",
    });
    validateRequiredString({
      errors,
      value: config.languageCode,
      code: "TEMPLATE_LANGUAGE_REQUIRED",
      message: "Template node requires config.languageCode",
      nodeId,
      field: "config.languageCode",
    });
    if (
      config.variables !== undefined &&
      (!Array.isArray(config.variables) ||
        config.variables.some((value) => typeof value !== "string"))
    ) {
      addIssue(
        errors,
        "TEMPLATE_VARIABLES_INVALID",
        "Template variables must be an array of strings",
        { nodeId, field: "config.variables" }
      );
    }
    validateTemplateMappings(node, errors);
  }

  if (
    node.type === "set_tag"
  ) {
    if (!["add", "remove"].includes(config.action)) {
      addIssue(
        errors,
        "TAG_ACTION_INVALID",
        "Set tag action must be add or remove",
        { nodeId, field: "config.action" }
      );
    }
    if (!Array.isArray(config.tags) || !config.tags.some(isNonEmptyString)) {
      addIssue(errors, "TAGS_REQUIRED", "Set tag node requires config.tags", {
        nodeId,
        field: "config.tags",
      });
    }
  }

  if (
    node.type === "set_attribute" &&
    (!config.attributes ||
      typeof config.attributes !== "object" ||
      Array.isArray(config.attributes) ||
      Object.keys(config.attributes).length === 0)
  ) {
    addIssue(
      errors,
      "ATTRIBUTES_REQUIRED",
      "Set attribute node requires config.attributes",
      { nodeId, field: "config.attributes" }
    );
  } else if (
    node.type === "set_attribute" &&
    Object.keys(config.attributes).some(
      (key) => !String(key || "").trim() || key.includes(".") || key.startsWith("$")
    )
  ) {
    addIssue(
      errors,
      "ATTRIBUTE_KEY_INVALID",
      "Attribute keys cannot be empty, contain dots, or start with $",
      { nodeId, field: "config.attributes" }
    );
  }

  if (node.type === "request_intervention") {
    validateNoVariables(errors, nodeId, "config.message", config.message);
    if (
      config.message !== undefined &&
      config.message !== null &&
      typeof config.message !== "string"
    ) {
      addIssue(
        errors,
        "INTERVENTION_MESSAGE_INVALID",
        "Intervention message must be a string",
        { nodeId, field: "config.message" }
      );
    }
    if (
      config.assignToTeamId !== undefined &&
      config.assignToTeamId !== null &&
      !isNonEmptyString(config.assignToTeamId)
    ) {
      addIssue(
        errors,
        "INTERVENTION_ASSIGNEE_INVALID",
        "assignToTeamId must be a non-empty identifier",
        { nodeId, field: "config.assignToTeamId" }
      );
    }
  }

  if (node.type === "end") {
    validateNoVariables(errors, nodeId, "config.message", config.message);
  }

  if (node.type === "api_request") {
    const method = String(config.method || "").toUpperCase();
    if (!VALID_HTTP_METHODS.has(method)) {
      addIssue(
        errors,
        "API_METHOD_INVALID",
        "API request method must be GET, POST, PUT, PATCH, or DELETE",
        { nodeId, field: "config.method" }
      );
    }
    validateRequiredString({
      errors,
      value: config.url,
      code: "API_URL_REQUIRED",
      message: "API request node requires config.url",
      nodeId,
      field: "config.url",
    });
    if (isNonEmptyString(config.url) && !isVariableSafeUrl(config.url)) {
      addIssue(
        errors,
        "API_URL_INVALID",
        "API request URL must be a valid http/https URL. Variable placeholders are allowed inside the URL.",
        { nodeId, field: "config.url" }
      );
    }
    if (
      config.timeoutMs !== undefined &&
      (!Number.isInteger(config.timeoutMs) ||
        config.timeoutMs < 1000 ||
        config.timeoutMs > 30000)
    ) {
      addIssue(
        errors,
        "API_TIMEOUT_INVALID",
        "API request timeoutMs must be between 1000 and 30000",
        { nodeId, field: "config.timeoutMs" }
      );
    }
    if (
      config.headers !== undefined &&
      (!config.headers ||
        typeof config.headers !== "object" ||
        Array.isArray(config.headers))
    ) {
      addIssue(
        errors,
        "API_HEADERS_INVALID",
        "API request headers must be an object",
        { nodeId, field: "config.headers" }
      );
    } else if (config.headers && typeof config.headers === "object") {
      for (const headerName of Object.keys(config.headers)) {
        if (FORBIDDEN_API_HEADERS.has(String(headerName || "").trim().toLowerCase())) {
          addIssue(
            errors,
            "API_HEADER_NOT_ALLOWED",
            `API request header '${headerName}' is not allowed`,
            { nodeId, field: "config.headers" }
          );
        }
      }
    }
    if (
      config.queryParams !== undefined &&
      (!config.queryParams ||
        typeof config.queryParams !== "object" ||
        Array.isArray(config.queryParams))
    ) {
      addIssue(
        errors,
        "API_QUERY_PARAMS_INVALID",
        "API request queryParams must be an object",
        { nodeId, field: "config.queryParams" }
      );
    }
    if (
      config.responseMapping !== undefined &&
      (!config.responseMapping ||
        typeof config.responseMapping !== "object" ||
        Array.isArray(config.responseMapping))
    ) {
      addIssue(
        errors,
        "API_RESPONSE_MAPPING_INVALID",
        "API responseMapping must be an object",
        { nodeId, field: "config.responseMapping" }
      );
    } else if (config.responseMapping && typeof config.responseMapping === "object") {
      for (const [contextKey, mapping] of Object.entries(config.responseMapping)) {
        if (!isValidContextKey(contextKey)) {
          addIssue(
            errors,
            "API_RESPONSE_MAPPING_KEY_INVALID",
            `Response mapping key '${contextKey}' is not a valid context key`,
            { nodeId, field: "config.responseMapping" }
          );
        }
        if (SENSITIVE_API_CONTEXT_KEY_PATTERN.test(String(contextKey || ""))) {
          addIssue(
            errors,
            "API_RESPONSE_MAPPING_KEY_SENSITIVE",
            `Response mapping key '${contextKey}' is sensitive and cannot be stored in flow context`,
            { nodeId, field: "config.responseMapping" }
          );
        }
        if (typeof mapping === "object" && mapping !== null && !Array.isArray(mapping)) {
          if (!isNonEmptyString(mapping.path)) {
            addIssue(
              errors,
              "API_RESPONSE_MAPPING_PATH_REQUIRED",
              `Response mapping '${contextKey}' requires a path`,
              { nodeId, field: "config.responseMapping.path" }
            );
          }
          if (mapping.type && !VALID_RESPONSE_MAPPING_TYPES.has(mapping.type)) {
            addIssue(
              errors,
              "API_RESPONSE_MAPPING_TYPE_INVALID",
              `Response mapping '${contextKey}' has an invalid type`,
              { nodeId, field: "config.responseMapping.type" }
            );
          }
        }
      }
    }

    if (["POST", "PUT", "PATCH"].includes(method) && !isValidJsonString(config.body)) {
      addIssue(
        errors,
        "API_BODY_JSON_INVALID",
        "API request body must be valid JSON for POST, PUT, and PATCH",
        { nodeId, field: "config.body" }
      );
    }

    for (const handle of ["success", "failure"]) {
      if (
        !outgoingEdges.some(
          (edge) =>
            String(edge.sourceHandle || "").trim().toLowerCase() === handle
        )
      ) {
        addIssue(
          errors,
          `API_${handle.toUpperCase()}_EDGE_MISSING`,
          `API request node requires a ${handle} outgoing edge`,
          { nodeId, field: "edges" }
        );
      }
    }
  }
}

function applyPublishDefaults(draft) {
  const nodes = Array.isArray(draft?.nodes)
    ? draft.nodes.map((node) => {
        if (node?.type !== "api_request") return node;
        const timeout = Number(node.config?.timeoutMs);
        return {
          ...node,
          config: {
            ...(node.config || {}),
            timeoutMs:
              Number.isFinite(timeout) && timeout > 0 ? timeout : 10000,
          },
        };
      })
    : [];

  return {
    nodes,
    edges: Array.isArray(draft?.edges) ? draft.edges : [],
    fallbackNodeId: draft?.fallbackNodeId || null,
    handoverNodeId: draft?.handoverNodeId || null,
  };
}

function validateFlowDraft(flow) {
  const errors = [];
  const warnings = [];

  if (!isNonEmptyString(flow?.name)) {
    addIssue(errors, "FLOW_NAME_REQUIRED", "Flow name is required", {
      field: "name",
    });
  }

  validateTrigger(flow?.trigger, errors);
  validateRuntimeSettings(flow?.runtimeSettings, errors);

  const draft = flow?.draft || {};
  if (!Array.isArray(draft.nodes)) {
    addIssue(errors, "NODES_INVALID", "Flow nodes must be an array", {
      field: "draft.nodes",
    });
  }
  if (!Array.isArray(draft.edges)) {
    addIssue(errors, "EDGES_INVALID", "Flow edges must be an array", {
      field: "draft.edges",
    });
  }
  if (!Array.isArray(draft.nodes) || !Array.isArray(draft.edges)) {
    return { valid: false, errors, warnings };
  }

  const nodeIds = new Set();
  for (const node of draft.nodes) {
    const nodeId = isNonEmptyString(node?.id) ? node.id.trim() : "";
    if (!nodeId) {
      addIssue(errors, "NODE_ID_REQUIRED", "Every node requires an id", {
        field: "draft.nodes.id",
      });
    } else if (nodeIds.has(nodeId)) {
      addIssue(errors, "NODE_ID_DUPLICATE", `Duplicate node id '${nodeId}'`, {
        nodeId,
        field: "draft.nodes.id",
      });
    } else {
      nodeIds.add(nodeId);
    }

    if (!VALID_NODE_TYPES.has(node?.type)) {
      addIssue(
        errors,
        "NODE_TYPE_INVALID",
        `Node type '${String(node?.type || "")}' is invalid`,
        { nodeId, field: "type" }
      );
    }
  }

  const startNodes = draft.nodes.filter((node) => node?.type === "start");
  if (startNodes.length === 0) {
    addIssue(errors, "START_NODE_REQUIRED", "At least one start node is required", {
      field: "draft.nodes",
    });
  }

  for (const [field, value] of [
    ["draft.fallbackNodeId", draft.fallbackNodeId],
    ["draft.handoverNodeId", draft.handoverNodeId],
  ]) {
    if (isNonEmptyString(value) && !nodeIds.has(value.trim())) {
      addIssue(
        errors,
        "SPECIAL_NODE_INVALID",
        `${field} does not reference an existing node`,
        { field }
      );
    }
  }

  const outgoingBySource = new Map();
  for (const edge of draft.edges) {
    const source = isNonEmptyString(edge?.source) ? edge.source.trim() : "";
    const target = isNonEmptyString(edge?.target) ? edge.target.trim() : "";
    if (!source || !nodeIds.has(source)) {
      addIssue(
        errors,
        "EDGE_SOURCE_INVALID",
        `Edge source '${source}' does not reference an existing node`,
        { field: "draft.edges.source" }
      );
    }
    if (!target || !nodeIds.has(target)) {
      addIssue(
        errors,
        "EDGE_TARGET_INVALID",
        `Edge target '${target}' does not reference an existing node`,
        { field: "draft.edges.target" }
      );
    }
    if (source) {
      const outgoing = outgoingBySource.get(source) || [];
      outgoing.push(edge);
      outgoingBySource.set(source, outgoing);
    }
  }

  for (const startNode of startNodes) {
    const outgoing = outgoingBySource.get(String(startNode.id || "").trim()) || [];
    if (outgoing.length !== 1) {
      addIssue(
        errors,
        "START_OUTGOING_EDGE_INVALID",
        "Start node must have exactly one outgoing edge",
        { nodeId: startNode.id, field: "edges" }
      );
    }
  }

  for (const node of draft.nodes) {
    const outgoing = outgoingBySource.get(String(node?.id || "").trim()) || [];
    validateNode(
      node,
      outgoing,
      draft.fallbackNodeId,
      errors,
      warnings
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = {
  validateFlowDraft,
  applyPublishDefaults,
};
