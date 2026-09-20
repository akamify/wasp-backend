const { HttpError } = require("@shared/utils/httpError");
const mongoose = require("mongoose");

function objectId(value) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) throw new HttpError(400, "Invalid identifier");
  return new mongoose.Types.ObjectId(value);
}
const ownerOf = (workspace) => String(workspace.ownerUserId || workspace.ownerId);
const usable = (workspace) => workspace.isActive && workspace.status === "active" && !workspace.deletedAt;
function authorizedLinks(group, workspaces) {
  const byId = new Map(workspaces.map((w) => [String(w._id), w]));
  return (group?.links || []).filter((link) => {
    const workspace = byId.get(String(link.workspaceId));
    return link.status === "active" && workspace && usable(workspace) && ownerOf(workspace) === String(link.ownerId);
  });
}
function reportFilter(query, now = new Date()) {
  const environment = query.environment || "live";
  if (!["test", "live"].includes(environment)) throw new HttpError(400, "Choose test or live");
  const parse = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "Dates must use YYYY-MM-DD (UTC)");
    const date = new Date(value + "T00:00:00.000Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, "Invalid date");
    return date;
  };
  const end = parse(query.to, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
  const start = parse(query.from, new Date(end.getTime() - 30 * 86400000));
  if (end <= start || end - start > 366 * 86400000) throw new HttpError(400, "Choose a date range of 1–366 days; end date is exclusive");
  const after = query.after === undefined ? null : objectId(query.after);
  return { environment, start, end, after };
}
module.exports = { objectId, ownerOf, usable, authorizedLinks, reportFilter };
