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

function parseListQuery(req) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  return { page, limit, skip, rx };
}

module.exports = { parseListQuery };

