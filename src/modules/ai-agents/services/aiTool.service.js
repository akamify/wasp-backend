const axios = require("axios");
const Joi = require("joi");
const { Contact } = require("@infra/database/Contact");
const { Conversation } = require("@infra/database/Conversation");
const { upsertContactMetadataForUser } = require("@shared/services/contactService");
const {
  AiRuntimeNonRetryableError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");

const DEFAULT_TOOL_TIMEOUT_MS = Math.max(Number(process.env.AI_TOOL_TIMEOUT_MS || 10000), 1000);

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
    description: "Send approved WhatsApp reply buttons that can start configured automation flows.",
    arguments: { text: "string", buttonIds: "string[]" },
    validator: Joi.object({
      text: Joi.string().trim().max(1024).allow("").default(""),
      buttonIds: Joi.array().items(Joi.string().trim().min(1).max(256)).min(1).max(3).unique().required(),
    }),
  },
};

function publicToolConfig(tool) {
  if (tool?.type !== "send_buttons") return {};
  const buttons = Array.isArray(tool?.config?.buttons) ? tool.config.buttons : [];
  return {
    availableButtons: buttons
      .map((button) => ({
        id: String(button?.id || "").trim(),
        title: String(button?.title || "").trim(),
        description: String(button?.description || "").trim(),
      }))
      .filter((button) => button.id && button.title),
  };
}

function toolDefinitions(agent) {
  return (agent.tools || [])
    .filter((tool) => tool?.enabled && TOOL_SCHEMAS[tool.type])
    .map((tool) => ({
      name: tool.type,
      ...TOOL_SCHEMAS[tool.type],
      ...publicToolConfig(tool),
    }));
}

function toolInstruction(agent) {
  const definitions = toolDefinitions(agent);
  if (!definitions.length) return "No tools are enabled. Do not return tool calls.";
  return [
    "Tool mode is enabled.",
    "When a tool is needed, return ONLY compact JSON in this exact shape:",
    '{"type":"tool_call","name":"set_tag","arguments":{"tag":"hot_lead"},"confidence":0.8}',
    "Do not mix tool JSON with customer-facing text.",
    "Only call tools that are explicitly enabled.",
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

function isObjectIdString(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || "").trim());
}

async function executeSendButtons({ agent, toolConfig, args }) {
  const configuredButtons = Array.isArray(toolConfig?.config?.buttons)
    ? toolConfig.config.buttons
    : [];
  const byId = new Map();
  for (const rawButton of configuredButtons) {
    const id = String(rawButton?.id || "").trim();
    const title = String(rawButton?.title || "").trim();
    const flowId = String(rawButton?.flowId || "").trim();
    if (!id || !title || !isObjectIdString(flowId)) continue;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        title: title.slice(0, 20),
        flowId,
      });
    }
  }

  const selected = [];
  for (const requestedId of args.buttonIds || []) {
    const id = String(requestedId || "").trim();
    const button = byId.get(id);
    if (!button) {
      return {
        ok: false,
        action: "reply",
        publicReply: "That option is not configured right now. Let me connect you with our team.",
        error: "button_not_configured",
      };
    }
    selected.push(button);
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
  const buttons = selected.slice(0, 3).map((button) => ({
    id: button.id,
    title: button.title,
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
        buttons: selected.slice(0, 3).map((button) => ({
          id: button.id,
          title: button.title,
          action: {
            type: "start_flow",
            flowId: button.flowId,
          },
        })),
      },
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
  executeRequestedTools,
};
