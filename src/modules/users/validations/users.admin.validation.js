function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 25) || 25;
  const limit = Math.min(Math.max(limitRaw, 5), 200);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchRegex(req) {
  const q = String(req.query.q || "").trim();
  if (!q) return null;
  return new RegExp(escapeRegExp(q), "i");
}

function normalizeListOption(value) {
  return String(value || "").trim().toLowerCase();
}

function parseSort(req, allowed, fallback) {
  const raw = normalizeListOption(req.query.sort);
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

function parseFilter(req, allowed, fallback) {
  const raw = normalizeListOption(req.query.filter);
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

function shouldIncludeTestData(req) {
  const v = String(req.query.includeTest || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function testDataNorFilter() {
  // Exclude common seed/smoke users by email/name patterns.
  // This is intentionally conservative and can be bypassed with `?includeTest=1`.
  return [
    { email: /@example\.com$/i },
    { email: /@test\.com$/i },
    { email: /^smoke\+/i },
    { email: /^legacy\+/i },
    { email: /^e2e\+/i },
    { email: /^dbg\+/i },
    { name: /^smoke/i },
    { name: /^legacy/i },
    { name: /^e2e/i },
    { name: /^dbg/i },
  ];
}

function parseListUsersQuery(req) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "admin", "member", "banned", "blocked"], "all");
  const sortKey = parseSort(req, ["recent", "old", "az"], "recent");
  const includeTest = shouldIncludeTestData(req);
  return { page, limit, skip, rx, filterKey, sortKey, includeTest };
}

module.exports = {
  parseListUsersQuery,
  shouldIncludeTestData,
  testDataNorFilter,
};
