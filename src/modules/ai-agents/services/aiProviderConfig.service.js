const { AiProviderConfig } = require("@infra/database/AiProviderConfig");
const { HttpError } = require("@shared/utils/httpError");

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_AI_AGENT_MODEL || "gemini-1.5-flash";
const DEFAULT_GEMINI_MODELS = Object.freeze([
  { key: "gemini-1.5-flash", label: "Gemini 1.5 Flash", deprecated: false, sortOrder: 10 },
  { key: "gemini-1.5-pro", label: "Gemini 1.5 Pro", deprecated: false, sortOrder: 20 },
]);

function normalizeModelKey(value) {
  return String(value || "").trim();
}

function normalizeModels(values) {
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(values) ? values : []) {
    const key = normalizeModelKey(item?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      label: String(item?.label || key).trim() || key,
      deprecated: Boolean(item?.deprecated),
      sortOrder: Math.max(0, Number(item?.sortOrder || rows.length * 10) || 0),
    });
  }
  return rows.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || a.key.localeCompare(b.key));
}

function buildFallbackConfig() {
  const models = normalizeModels(DEFAULT_GEMINI_MODELS);
  const defaultModel = models.find((item) => item.key === DEFAULT_GEMINI_MODEL)?.key || models[0]?.key || DEFAULT_GEMINI_MODEL;
  return {
    provider: "gemini",
    defaultModel,
    models,
    manualModeEnabled: false,
    source: "fallback",
  };
}

function serializeProviderConfig(row) {
  const fallback = buildFallbackConfig();
  const value = row?.toObject ? row.toObject() : row || {};
  const models = normalizeModels(value.models?.length ? value.models : fallback.models);
  const defaultModel = models.find((item) => item.key === value.defaultModel)?.key || fallback.defaultModel;
  return {
    provider: "gemini",
    defaultModel,
    models,
    manualModeEnabled: Boolean(value.manualModeEnabled),
    source: row ? "database" : fallback.source,
    updatedAt: value.updatedAt || null,
  };
}

async function getGeminiProviderConfig() {
  const row = await AiProviderConfig.findOne({ provider: "gemini" }).lean(false);
  return serializeProviderConfig(row);
}

async function resolveGeminiModel(requestedModel) {
  const config = await getGeminiProviderConfig();
  const requested = normalizeModelKey(requestedModel);
  if (!requested) return { model: config.defaultModel, config };
  const match = config.models.find((item) => item.key === requested);
  if (!match) {
    throw new HttpError(400, "Invalid Gemini model selected.");
  }
  return { model: match.key, config };
}

async function updateGeminiProviderConfig({ payload = {}, actorId = null }) {
  const models = normalizeModels(payload.models);
  if (!models.length) {
    throw new HttpError(400, "At least one Gemini model must remain enabled.");
  }
  const defaultModel = normalizeModelKey(payload.defaultModel);
  if (!models.some((item) => item.key === defaultModel)) {
    throw new HttpError(400, "Default Gemini model must exist in enabled models.");
  }

  const row = await AiProviderConfig.findOneAndUpdate(
    { provider: "gemini" },
    {
      $set: {
        provider: "gemini",
        defaultModel,
        models,
        manualModeEnabled: Boolean(payload.manualModeEnabled),
        updatedBy: actorId || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return serializeProviderConfig(row);
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODELS,
  getGeminiProviderConfig,
  resolveGeminiModel,
  serializeProviderConfig,
  updateGeminiProviderConfig,
};
