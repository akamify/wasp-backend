const axios = require("axios");
const Joi = require("joi");
const { Contact } = require("@infra/database/Contact");
const { Conversation } = require("@infra/database/Conversation");
const { upsertContactMetadataForUser } = require("@shared/services/contactService");
const {
  AiRuntimeNonRetryableError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");

const DEFAULT_TOOL_TIMEOUT_MS = Math.max(Number(process.env.AI_TOOL_TIMEOUT_MS || 10000), 1000);
const ACTION_KINDS = new Set(["flow", "template", "handover"]);

function plannedTools(agent) {
  return (agent.tools || [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      type: tool.type,
      status: "available",
    }));
}

const TOOL_SCHEMAS = {
  crm_lookup: {
    description: "Look up CRM/contact information when the customer asks about known records.",
    arguments: { query: "string" },
    validator: Joi.object({
      query: Joi.string().trim().max(200).allow("").default(""),
    }),
  },
  contact_update: {
    description: "Update a supported contact profile field.",
    arguments: { field: "string", value: "string" },
    validator: Joi.object({
      field: Joi.string().trim().valid("name", "email", "company", "notes", "language").required(),
      value: Joi.alternatives().try(Joi.string().trim().max(500), Joi.number(), Joi.boolean()).required(),
    }),
  },
  set_tag: {
    description: "Add a tag to the current contact.",
    arguments: { tag: "string" },
    validator: Joi.object({
      tag: Joi.string().trim().min(1).max(40).required(),
    }),
  },
  set_attribute: {
    description: "Set a custom attribute on the current contact.",
    arguments: { key: "string", value: "string" },
    validator: Joi.object({
      key: Joi.string().trim().min(1).max(80).required(),
      value: Joi.alternatives().try(Joi.string().trim().max(500), Joi.number(), Joi.boolean()).required(),
    }),
  },
  api_request: {
    description: "Trigger a configured allowlisted external API action.",
    arguments: { endpointKey: "string", payload: "object" },
    validator: Joi.object({
      endpointKey: Joi.string().trim().min(1).max(120).required(),
      payload: Joi.object().unknown(true).default({}),
    }),
  },
  handover: {
    description: "Request human handover when the AI is unsure or policy requires it.",
    arguments: { reason: "string" },
    validator: Joi.object({
      reason: Joi.string().trim().max(300).allow("").default("ai_tool_handover"),
    }),
  },
  send_buttons: {
    description: "Send approved WhatsApp reply buttons only when the customer needs to choose between assigned semantic actions.",
    arguments: { text: "string", choices: "string[]" },
    validator: Joi.object({
      text: Joi.string().trim().max(1024).allow("").default(""),
      choices: Joi.array().items(Joi.string().trim().min(1).max(80)).min(1).max(3).unique().optional(),
      buttonIds: Joi.array().items(Joi.string().trim().min(1).max(256)).min(1).max(3).unique().optional(),
    }).or("choices", "buttonIds"),
  },
  send_list: {
    description: "Send an approved WhatsApp list only when more than three assigned choices are useful.",
    arguments: { text: "string", title: "string", buttonText: "string", choices: "string[]" },
    validator: Joi.object({
      text: Joi.string().trim().max(1024).allow("").default(""),
      title: Joi.string().trim().max(60).allow("").default("Options"),
      buttonText: Joi.string().trim().max(20).allow("").default("View options"),
      choices: Joi.array().items(Joi.string().trim().min(1).max(80)).min(1).max(10).unique().required(),
    }),
  },
  start_flow: {
    description: "Start one assigned automation flow when the customer clearly asks for that process.",
    arguments: { flowKey: "string", reason: "string" },
    validator: Joi.object({
      flowKey: Joi.string().trim().min(1).max(80).required(),
      reason: Joi.string().trim().max(240).allow("").default("ai_start_flow"),
    }),
  },
  send_template: {
    description: "Send one assigned approved WhatsApp template when specifically appropriate.",
    arguments: { templateKey: "string", hints: "object" },
    validator: Joi.object({
      templateKey: Joi.string().trim().min(1).max(80).required(),
      hints: Joi.object().pattern(Joi.string().trim().max(80), Joi.string().trim().max(300)).default({}),
    }),
  },
};

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function safeTitle(value, fallback) {
  return String(value || fallback || "").trim().slice(0, 40);
}

function buildModelActionCatalog(agent) {
  const tools = Array.isArray(agent?.tools) ? agent.tools : [];
  const choices = [];
  const flows = [];
  const templates = [];
  const seen = new Set();

  const addChoice = (choice) => {
    const key = normalizeKey(choice?.key);
    const kind = String(choice?.kind || "").trim();
    if (!key || !ACTION_KINDS.has(kind) || seen.has(key)) return;
    seen.add(key);
    choices.push({
      key,
      kind,
      title: safeTitle(choice.title || choice.name, key),
      purpose: String(choice.purpose || "").trim().slice(0, 300),
      whenToUse: Array.isArray(choice.whenToUse)
        ? choice.whenToUse.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : [],
    });
  };

  const flowTool = tools.find((tool) => tool?.enabled && tool.type === "start_flow");
  for (const flow of Array.isArray(flowTool?.config?.flows) ? flowTool.config.flows : []) {
    const key = normalizeKey(flow?.key);
    if (!key) continue;
    const item = {
      key,
      name: String(flow?.name || flow?.title || key).trim().slice(0, 120),
      title: safeTitle(flow?.title || flow?.name, key),
      purpose: String(flow?.purpose || flow?.description || "").trim().slice(0, 300),
      whenToUse: Array.isArray(flow?.whenToUse)
        ? flow.whenToUse.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 8)
        : [],
    };
    flows.push(item);
    addChoice({ ...item, kind: "flow" });
  }

  const templateTool = tools.find((tool) => tool?.enabled && tool.type === "send_template");
  for (const template of Array.isArray(templateTool?.config?.templates) ? templateTool.config.templates : []) {
    const key = normalizeKey(template?.key);
    if (!key) continue;
    const item = {
      key,
      name: String(template?.name || template?.title || key).trim().slice(0, 120),
      title: safeTitle(template?.title || template?.name, key),
      purpose: String(template?.purpose || "").trim().slice(0, 300),
    };
    templates.push(item);
    addChoice({ ...item, kind: "template" });
  }

  const buttonTool = tools.find((tool) => tool?.enabled && tool.type === "send_buttons");
  for (const button of Array.isArray(buttonTool?.config?.buttons) ? buttonTool.config.buttons : []) {
    const key = normalizeKey(button?.key || button?.id);
    if (!key) continue;
    if (button?.flowId) {
      addChoice({
        key,
        kind: "flow",
        title: safeTitle(button?.title, key),
        purpose: String(button?.description || "").trim().slice(0, 300),
      });
    }
  }

  return { flows, templates, choices };
}

function resolveAssignedAction(agent, key) {
  const requested = normalizeKey(key);
  if (!requested) return null;
  const tools = Array.isArray(agent?.tools) ? agent.tools : [];
  const flowTool = tools.find((tool) => tool?.enabled && tool.type === "start_flow");
  const flow = (Array.isArray(flowTool?.config?.flows) ? flowTool.config.flows : [])
    .find((item) => normalizeKey(item?.key) === requested);
  if (flow?.flowId) {
    return {
      key: requested,
      kind: "flow",
      title: safeTitle(flow.title || flow.name, requested).slice(0, 20),
      purpose: String(flow.purpose || "").trim(),
      serverConfig: flow,
    };
  }

  const templateTool = tools.find((tool) => tool?.enabled && tool.type === "send_template");
  const template = (Array.isArray(templateTool?.config?.templates) ? templateTool.config.templates : [])
    .find((item) => normalizeKey(item?.key) === requested);
  if (template?.templateId) {
    return {
      key: requested,
      kind: "template",
      title: safeTitle(template.title || template.name, requested).slice(0, 20),
      purpose: String(template.purpose || "").trim(),
      serverConfig: template,
    };
  }

  const buttonTool = tools.find((tool) => tool?.enabled && tool.type === "send_buttons");
  const legacy = (Array.isArray(buttonTool?.config?.buttons) ? buttonTool.config.buttons : [])
    .find((item) => normalizeKey(item?.key || item?.id) === requested);
  if (legacy?.flowId) {
    return {
      key: requested,
      kind: "flow",
      title: safeTitle(legacy.title, requested).slice(0, 20),
      purpose: String(legacy.description || "").trim(),
      serverConfig: {
        key: requested,
        flowId: legacy.flowId,
        name: legacy.title || requested,
        title: legacy.title || requested,
        purpose: legacy.description || "",
      },
    };
  }

  return null;
}

function publicToolConfig(tool, agent) {
  if (!["send_buttons", "send_list", "start_flow", "send_template"].includes(String(tool?.type || ""))) {
    return {};
  }
  return { assignedActionCatalog: buildModelActionCatalog(agent) };
}

function toolDefinitions(agent) {
  return (agent.tools || [])
    .filter((tool) => tool?.enabled && TOOL_SCHEMAS[tool.type])
    .map((tool) => ({
      name: tool.type,
      ...TOOL_SCHEMAS[tool.type],
      ...publicToolConfig(tool, agent),
    }));
}

function toolInstruction(agent) {
  const definitions = toolDefinitions(agent);
  if (!definitions.length) return "No tools are enabled. Do not return tool calls.";
  return [
    "Tool mode is enabled.",
    "Decision priority: answer with normal text when the customer's question can be answered from the provided knowledge/contact/runtime context.",
    "Use start_flow only when the customer clearly wants an assigned process.",
    "Use send_buttons or send_list only when the customer needs to choose between useful options; do not use them for every response.",
    "For executable choices, use semantic keys from assignedActionCatalog. For purely conversational choices, you may provide short customer-facing option labels from the available knowledge.",
    "Use send_template only when the assigned template is specifically appropriate.",
    "When a tool is needed, return ONLY compact JSON in this exact shape:",
    '{"type":"tool_call","name":"set_tag","arguments":{"tag":"hot_lead"},"confidence":0.8}',
    "Do not mix tool JSON with customer-facing text.",
    "Only call tools that are explicitly enabled.",
    "Never output MongoDB IDs, Flow IDs, Template IDs, URLs, callback payloads, or Meta JSON.",
    "Available tool schemas:",
    JSON.stringify(definitions),
  ].join("\n");
}

function parseToolCall(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.type !== "tool_call") return null;
    if (!TOOL_SCHEMAS[parsed.name]) return null;
    return {
      type: "tool_call",
      name: parsed.name,
      arguments: parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {},
      confidence: Number(parsed.confidence || 0),
      status: "planned",
    };
  } catch {
    return null;
  }
}

function findEnabledTool(agent, name) {
  return (agent?.tools || []).find((tool) => tool?.enabled && tool?.type === name) || null;
}

async function executeCrmLookup({ context }) {
  const contact = context?.contact || null;
  const conversation = context?.conversation || null;
  if (!contact && !conversation) {
    return {
      ok: false,
      publicReply: "I could not find enough CRM context for this request.",
      error: "crm_context_missing",
    };
  }
  return {
    ok: true,
    action: "reply",
    publicReply: contact
      ? `I found your CRM details. I currently have ${contact.name || "your contact"} saved with phone ${contact.phone || context?.phone || "unknown"}.`
      : "I found your CRM conversation details.",
    result: {
      contact: contact
        ? {
            id: String(contact._id || ""),
            phone: contact.phone || "",
            name: contact.name || "",
            company: contact.company || "",
            email: contact.email || "",
            tags: Array.isArray(contact.tags) ? contact.tags : [],
            attributes: contact.attributes || {},
          }
        : null,
      conversation: conversation
        ? {
            id: String(conversation._id || ""),
            phone: conversation.phone || "",
            aiState: conversation.aiState || null,
            assignedEmployeeId: conversation.assignedEmployeeId ? String(conversation.assignedEmployeeId) : null,
          }
        : null,
    },
  };
}

async function executeContactUpdate({ workspaceId, context, args }) {
  const contactId = context?.contact?._id || null;
  if (!contactId) {
    return {
      ok: false,
      publicReply: "I could not identify which contact to update.",
      error: "contact_missing",
    };
  }
  const updates = {};
  updates[args.field] = args.value;
  const updated = await Contact.findOneAndUpdate(
    { _id: contactId, workspaceId },
    { $set: updates },
    { returnDocument: "after", runValidators: true }
  );
  if (!updated) {
    return {
      ok: false,
      publicReply: "I could not update that contact.",
      error: "contact_not_found",
    };
  }
  return {
    ok: true,
    action: "reply",
    publicReply: `I've updated the contact ${args.field}.`,
    result: {
      contactId: String(updated._id),
      field: args.field,
      value: updated[args.field],
    },
  };
}

async function executeSetTag({ workspaceId, context, args }) {
  const phone = context?.phone || context?.contact?.phone || "";
  if (!phone || !context?.wabaId) {
    return {
      ok: false,
      publicReply: "I could not identify the active contact for tagging.",
      error: "contact_context_missing",
    };
  }
  const updated = await upsertContactMetadataForUser({
    userId: workspaceId,
    wabaId: context.wabaId,
    phoneNumberId: context.phoneNumberId || null,
    phone,
    patch: { tags: [args.tag] },
    createIfMissing: false,
  });
  if (!updated) {
    return {
      ok: false,
      publicReply: "I could not add that tag right now.",
      error: "tag_update_failed",
    };
  }
  return {
    ok: true,
    action: "reply",
    publicReply: `I've tagged this contact as ${args.tag}.`,
    result: {
      contactId: String(updated._id),
      tag: args.tag,
      tags: Array.isArray(updated.tags) ? updated.tags : [],
    },
  };
}

async function executeSetAttribute({ workspaceId, context, args }) {
  const phone = context?.phone || context?.contact?.phone || "";
  if (!phone || !context?.wabaId) {
    return {
      ok: false,
      publicReply: "I could not identify the active contact for saving that detail.",
      error: "contact_context_missing",
    };
  }
  const updated = await upsertContactMetadataForUser({
    userId: workspaceId,
    wabaId: context.wabaId,
    phoneNumberId: context.phoneNumberId || null,
    phone,
    patch: { attributes: { [args.key]: args.value } },
    createIfMissing: false,
  });
  if (!updated) {
    return {
      ok: false,
      publicReply: "I could not save that detail right now.",
      error: "attribute_update_failed",
    };
  }
  return {
    ok: true,
    action: "reply",
    publicReply: `I've saved ${args.key} to the contact profile.`,
    result: {
      contactId: String(updated._id),
      key: args.key,
      value: args.value,
    },
  };
}

async function executeApiRequest({ toolConfig, args }) {
  const endpointList = Array.isArray(toolConfig?.config?.endpoints) ? toolConfig.config.endpoints : [];
  const endpoint = endpointList.find((item) => String(item?.key || "").trim() === String(args.endpointKey || "").trim());
  if (!endpoint || !endpoint.url) {
    return {
      ok: false,
      publicReply: "That API action is not configured.",
      error: "endpoint_not_allowed",
    };
  }

  const method = String(endpoint.method || "POST").trim().toUpperCase();
  const headers = endpoint.headers && typeof endpoint.headers === "object" ? endpoint.headers : {};
  const timeout = Math.max(Number(endpoint.timeoutMs || 10000), 1000);

  const response = await axios({
    method,
    url: endpoint.url,
    data: args.payload || {},
    headers,
    timeout,
  });

  return {
    ok: true,
    action: "reply",
    publicReply: endpoint.successMessage || "I've completed that request.",
    result: {
      endpointKey: args.endpointKey,
      status: Number(response.status || 200),
      data: response.data || null,
    },
  };
}

async function executeHandover({ args }) {
  return {
    ok: true,
    action: "handover",
    publicReply: "Let me connect you with our team for further help.",
    result: {
      reason: args.reason || "ai_tool_handover",
    },
  };
}

function selectedChoices(args) {
  return (Array.isArray(args.choices) && args.choices.length ? args.choices : args.buttonIds || [])
    .map((item) => {
      const raw = String(item || "").trim();
      return {
        key: normalizeKey(raw),
        title: raw,
      };
    })
    .filter((item) => item.key || item.title);
}

function normalizeConversationChoiceId(value, fallback) {
  return String(value || fallback || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function conversationalChoice(choice, index) {
  const title = safeTitle(choice.title || choice.key, `Option ${index + 1}`);
  const key = normalizeConversationChoiceId(choice.key || title, `option_${index + 1}`);
  if (!key || !title) return null;
  return {
    key,
    kind: "conversation",
    title,
    purpose: "",
    serverConfig: null,
  };
}

async function executeSendButtons({ agent, toolConfig, args }) {
  void toolConfig;
  const selected = [];
  for (const choice of selectedChoices(args).slice(0, 3)) {
    const action = resolveAssignedAction(agent, choice.key) || conversationalChoice(choice, selected.length);
    if (action) selected.push(action);
  }

  if (!selected.length) {
    return {
      ok: false,
      action: "reply",
      publicReply: "No options are configured right now. Let me connect you with our team.",
      error: "buttons_not_configured",
    };
  }

  const text =
    String(args.text || "").trim() ||
    String(toolConfig?.config?.defaultBody || "").trim() ||
    "Please choose an option.";
  const buttons = selected.map((item) => ({
    id: item.key,
    title: item.title,
  }));

  return {
    ok: true,
    action: "reply",
    publicReply: text,
    result: {
      buttonIds: buttons.map((button) => button.id),
      count: buttons.length,
    },
    outbound: {
      type: "interactive_buttons",
      text,
      buttons,
      aiButtonActions: {
        version: 1,
        source: "ai_agent",
        agentId: agent?._id ? String(agent._id) : null,
        actions: selected.map((item) => ({
          id: item.key,
          key: item.key,
          kind: item.kind,
          title: item.title,
        })),
      },
    },
  };
}

async function executeSendList({ agent, toolConfig, args }) {
  const selected = [];
  for (const choice of selectedChoices(args).slice(0, 10)) {
    const action = resolveAssignedAction(agent, choice.key) || conversationalChoice(choice, selected.length);
    if (action) selected.push(action);
  }
  const text = String(args.text || "").trim() || String(toolConfig?.config?.defaultBody || "").trim() || "Please choose an option.";
  const title = String(args.title || "").trim() || String(toolConfig?.config?.defaultTitle || "").trim() || "Options";
  const buttonText = String(args.buttonText || "").trim() || String(toolConfig?.config?.defaultButtonText || "").trim() || "View options";
  return {
    ok: true,
    action: "reply",
    publicReply: text,
    result: { choices: selected.map((item) => item.key), count: selected.length },
    outbound: {
      type: "interactive_list",
      text,
      buttonText: buttonText.slice(0, 20),
      sections: [
        {
          title: title.slice(0, 60),
          rows: selected.map((item) => ({
            id: item.key,
            title: item.title.slice(0, 24),
            description: item.purpose ? item.purpose.slice(0, 72) : "",
          })),
        },
      ],
      aiListActions: {
        version: 1,
        source: "ai_agent",
        agentId: agent?._id ? String(agent._id) : null,
        actions: selected.map((item) => ({
          id: item.key,
          key: item.key,
          kind: item.kind,
          title: item.title,
        })),
      },
    },
  };
}

async function executeStartFlow({ agent, args }) {
  const action = resolveAssignedAction(agent, args.flowKey);
  if (!action || action.kind !== "flow") {
    return {
      ok: false,
      action: "reply",
      publicReply: "That automation is not configured right now. Let me connect you with our team.",
      error: "flow_not_assigned",
    };
  }
  return {
    ok: true,
    action: "reply",
    publicReply: "I'll start that now.",
    result: { flowKey: action.key },
    outbound: {
      type: "start_flow",
      flowKey: action.key,
      reason: args.reason || "ai_start_flow",
    },
  };
}

async function executeSendTemplate({ agent, args }) {
  const action = resolveAssignedAction(agent, args.templateKey);
  if (!action || action.kind !== "template") {
    return {
      ok: false,
      action: "reply",
      publicReply: "That template is not configured right now. Let me connect you with our team.",
      error: "template_not_assigned",
    };
  }
  return {
    ok: true,
    action: "reply",
    publicReply: "I'll send that now.",
    result: { templateKey: action.key },
    outbound: {
      type: "template",
      templateKey: action.key,
      hints: args.hints || {},
    },
  };
}

function timeoutForTool(toolConfig) {
  const configured = Number(toolConfig?.config?.timeoutMs || 0);
  return Math.max(configured || DEFAULT_TOOL_TIMEOUT_MS, 1000);
}

async function withToolTimeout(executorPromise, { timeoutMs, toolName }) {
  let timeoutHandle = null;
  try {
    return await Promise.race([
      executorPromise,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new AiRuntimeNonRetryableError(`AI tool timed out: ${toolName}`, {
              code: "AI_TOOL_TIMEOUT",
              statusCode: 504,
              category: "tool",
              reason: "tool_timeout",
              details: { toolName, timeoutMs },
            })
          );
        }, timeoutMs);
        if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

const TOOL_EXECUTORS = {
  crm_lookup: executeCrmLookup,
  contact_update: executeContactUpdate,
  set_tag: executeSetTag,
  set_attribute: executeSetAttribute,
  api_request: executeApiRequest,
  handover: executeHandover,
  send_buttons: executeSendButtons,
  send_list: executeSendList,
  start_flow: executeStartFlow,
  send_template: executeSendTemplate,
};

async function executeSingleTool({ workspaceId, agent, toolCall, context = {} }) {
  const enabledTool = findEnabledTool(agent, toolCall?.name);
  if (!enabledTool) {
    return {
      name: toolCall?.name || "",
      ok: false,
      status: "skipped",
      error: "tool_not_enabled",
      publicReply: "That tool is not available for this agent.",
    };
  }

  const schema = TOOL_SCHEMAS[toolCall.name];
  const executor = TOOL_EXECUTORS[toolCall.name];
  if (!schema || !executor) {
    return {
      name: toolCall?.name || "",
      ok: false,
      status: "failed",
      error: "tool_not_supported",
      publicReply: "That tool is not supported.",
    };
  }

  try {
    const args = await schema.validator.validateAsync(toolCall.arguments || {}, {
      abortEarly: false,
      stripUnknown: true,
    });
    const execution = await withToolTimeout(
      executor({
        workspaceId,
        agent,
        toolConfig: enabledTool,
        args,
        context,
      }),
      {
        timeoutMs: timeoutForTool(enabledTool),
        toolName: toolCall.name,
      }
    );
    return {
      name: toolCall.name,
      ok: Boolean(execution?.ok),
      status: execution?.ok ? "executed" : "failed",
      arguments: args,
      action: execution?.action || "reply",
      publicReply: execution?.publicReply || "I completed that action.",
      result: execution?.result || null,
      outbound: execution?.outbound || null,
      error: execution?.error || null,
    };
  } catch (error) {
    if (error?.code === "AI_TOOL_TIMEOUT") {
      return {
        name: toolCall.name,
        ok: false,
        status: "timeout",
        arguments: toolCall.arguments || {},
        action: "handover",
        publicReply: "I am having trouble completing that request right now. Let me connect you with our team.",
        result: null,
        error: error.code,
      };
    }
    return {
      name: toolCall.name,
      ok: false,
      status: "failed",
      arguments: toolCall.arguments || {},
      action: "reply",
      publicReply: "I couldn't complete that action right now. Let me connect you with our team.",
      result: null,
      error: error?.message || "tool_execution_failed",
    };
  }
}

async function executeRequestedTools({ workspaceId, agent, toolCalls = [], context = {} }) {
  const calls = Array.isArray(toolCalls) ? toolCalls.filter(Boolean).slice(0, 1) : [];
  const executed = [];
  for (const call of calls) {
    executed.push(await executeSingleTool({ workspaceId, agent, toolCall: call, context }));
  }
  const first = executed[0] || null;
  return {
    executed,
    publicReply: first?.publicReply || null,
    action: first?.action || "reply",
    outbound: first?.outbound || null,
    ok: executed.every((item) => item.ok),
    note: executed.length ? "Tool execution completed." : "No tool execution requested.",
  };
}

module.exports = {
  plannedTools,
  toolDefinitions,
  toolInstruction,
  parseToolCall,
  buildModelActionCatalog,
  resolveAssignedAction,
  executeRequestedTools,
};
