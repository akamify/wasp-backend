const TERMINAL_STATUSES = ["fired", "retired"];
const BLOCKED_STATUSES = ["banned", "fired", "retired"];

function normalizeStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (["active", "banned", "fired", "retired"].includes(s)) return s;
  return "active";
}

function canLoginStatus(status) {
  return !BLOCKED_STATUSES.includes(normalizeStatus(status));
}

function getBlockedLoginMessage(status) {
  const s = normalizeStatus(status);
  if (s === "fired") return "This admin is fired and cannot login";
  if (s === "retired") return "This admin is retired and cannot login";
  if (s === "banned") return "This admin is banned";
  return "Account blocked";
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

function validateAdminStatusTransition(currentStatus, nextStatus) {
  const current = normalizeStatus(currentStatus);
  const next = normalizeStatus(nextStatus);
  if (current === next) return { ok: true };
  if (isTerminalStatus(current)) return { ok: false, message: "Fired/Retired status is terminal and cannot be changed" };
  if (current === "active" && ["banned", "fired", "retired"].includes(next)) return { ok: true };
  if (current === "banned" && next === "active") return { ok: true };
  return { ok: false, message: `Invalid status transition: ${current} -> ${next}` };
}

module.exports = {
  TERMINAL_STATUSES,
  BLOCKED_STATUSES,
  normalizeStatus,
  canLoginStatus,
  getBlockedLoginMessage,
  isTerminalStatus,
  validateAdminStatusTransition,
};

