const AI_STATES = Object.freeze({
  AI_ACTIVE: "AI_ACTIVE",
  HUMAN_ACTIVE: "HUMAN_ACTIVE",
  HANDOVER_PENDING: "HANDOVER_PENDING",
  PAUSED: "PAUSED",
  CLOSED: "CLOSED",
});

const LEGACY_AI_STATE_MAP = Object.freeze({
  ai: AI_STATES.AI_ACTIVE,
  human: AI_STATES.HUMAN_ACTIVE,
  handover_pending: AI_STATES.HANDOVER_PENDING,
  paused: AI_STATES.PAUSED,
  closed: AI_STATES.CLOSED,
});

const AI_STATE_VALUES = Object.freeze(Object.values(AI_STATES));

function normalizeAiState(value, { fallback = null } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (AI_STATE_VALUES.includes(raw)) return raw;
  return LEGACY_AI_STATE_MAP[raw] || fallback;
}

function isAiActiveState(value) {
  return normalizeAiState(value) === AI_STATES.AI_ACTIVE;
}

function isHumanControlledAiState(value) {
  const state = normalizeAiState(value);
  return [
    AI_STATES.HUMAN_ACTIVE,
    AI_STATES.HANDOVER_PENDING,
    AI_STATES.PAUSED,
    AI_STATES.CLOSED,
  ].includes(state);
}

module.exports = {
  AI_STATES,
  AI_STATE_VALUES,
  LEGACY_AI_STATE_MAP,
  normalizeAiState,
  isAiActiveState,
  isHumanControlledAiState,
};
