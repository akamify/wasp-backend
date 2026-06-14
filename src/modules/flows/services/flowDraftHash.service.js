const crypto = require("crypto");
const { normalizeRuntimeSettings } = require("@modules/flows/constants/flowRuntimeSettings");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }
  return value;
}

function documentValue(value) {
  return value?.toObject ? value.toObject() : value;
}

function flowDraftSnapshot(flow) {
  return {
    name: String(flow?.name || "").trim(),
    description: String(flow?.description || ""),
    trigger: documentValue(flow?.trigger) || null,
    draft: documentValue(flow?.draft) || {
      nodes: [],
      edges: [],
      fallbackNodeId: null,
      handoverNodeId: null,
    },
    runtimeSettings: normalizeRuntimeSettings(
      documentValue(flow?.runtimeSettings)
    ),
  };
}

function computeFlowDraftHash(flow) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(flowDraftSnapshot(flow))))
    .digest("hex");
}

module.exports = {
  computeFlowDraftHash,
  flowDraftSnapshot,
};
