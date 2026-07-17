function plannedTools(agent) {
  return (agent.tools || [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      type: tool.type,
      status: "available_not_executed",
    }));
}

const TOOL_SCHEMAS = {
  crm_lookup: {
    description: "Look up CRM/contact information when the customer asks about known records.",
    arguments: { query: "string" },
  },
  contact_update: {
    description: "Request an update to a contact profile field.",
    arguments: { field: "string", value: "string" },
  },
  set_tag: {
    description: "Request adding a tag to the current contact.",
    arguments: { tag: "string" },
  },
  set_attribute: {
    description: "Request setting a custom attribute on the current contact.",
    arguments: { key: "string", value: "string" },
  },
  api_request: {
    description: "Request a configured external API action.",
    arguments: { endpointKey: "string", payload: "object" },
  },
  handover: {
    description: "Request human handover when the AI is unsure or policy requires it.",
    arguments: { reason: "string" },
  },
};

function toolDefinitions(agent) {
  return (agent.tools || [])
    .filter((tool) => tool?.enabled && TOOL_SCHEMAS[tool.type])
    .map((tool) => ({
      name: tool.type,
      ...TOOL_SCHEMAS[tool.type],
    }));
}

function toolInstruction(agent) {
  const definitions = toolDefinitions(agent);
  if (!definitions.length) return "No tools are enabled. Do not return tool calls.";
  return [
    "Tool mode is planning-only in this test runtime.",
    "When a tool is needed, return ONLY compact JSON in this exact shape:",
    '{"type":"tool_call","name":"set_tag","arguments":{"tag":"hot_lead"},"confidence":0.8}',
    "Do not execute tools yourself. Do not mix tool JSON with customer-facing text.",
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
      status: "planned_not_executed",
    };
  } catch {
    return null;
  }
}

async function executeRequestedTools() {
  return {
    executed: [],
    note: "Tool execution is intentionally disabled in Phase 2 test runtime.",
  };
}

module.exports = {
  plannedTools,
  toolDefinitions,
  toolInstruction,
  parseToolCall,
  executeRequestedTools,
};
