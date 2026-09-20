const { randomUUID } = require("node:crypto");
const { BusinessGroup } = require("./model");
const { objectId, ownerOf, usable, authorizedLinks } = require("./policy");
const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");
const workspaceFields = "name ownerId ownerUserId isActive status deletedAt";
const ownerFilter = (userId) => ({ $or: [{ ownerUserId: userId }, { ownerUserId: null, ownerId: userId }] });

async function ownedWorkspaces(userId, after) {
  return Workspace.find({ ...ownerFilter(objectId(userId)), isActive: true, status: "active", deletedAt: null,
    ...(after ? { _id: { $gt: objectId(after) } } : {}) }).select(workspaceFields).sort({ _id: 1 }).limit(101).lean();
}
async function getGroup(userId) {
  const group = await BusinessGroup.findById(objectId(userId)).lean();
  if (!group) throw new HttpError(404, "Create your Business Group first");
  return group;
}
async function scope(userId) {
  const group = await getGroup(userId);
  const workspaces = await Workspace.find({ _id: { $in: group.links.map((l) => l.workspaceId) } }).select(workspaceFields).lean();
  return { group, workspaces, links: authorizedLinks(group, workspaces) };
}
async function saveGroup(userId, name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new HttpError(400, "Enter a group name (1–100 characters)");
  try {
    return await BusinessGroup.findOneAndUpdate({ _id: objectId(userId) }, { $set: { name: name.trim() }, $inc: { revision: 1 } },
      { upsert: true, new: true, runValidators: true }).lean();
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, "Group was created by another request. Refresh and retry");
    throw error;
  }
}
async function requestLink(userId, workspaceId) {
  const group = await getGroup(userId);
  const id = objectId(workspaceId);
  const workspace = await Workspace.findById(id).select(workspaceFields).lean();
  if (!workspace || !usable(workspace)) throw new HttpError(404, "Workspace unavailable");
  const ownerId = ownerOf(workspace);
  const now = new Date();
  const link = { workspaceId: id, ownerId, requestId: randomUUID(), status: ownerId === userId ? "active" : "pending",
    requestedAt: now, decidedAt: ownerId === userId ? now : null, decidedBy: ownerId === userId ? objectId(userId) : null };
  const old = group.links.find((l) => String(l.workspaceId) === String(id));
  if (old && ["active", "pending"].includes(old.status) && String(old.ownerId) === ownerId) throw new HttpError(409, "Workspace already linked or awaiting approval");
  const links = group.links.filter((l) => String(l.workspaceId) !== String(id));
  if (links.length >= 100) throw new HttpError(409, "A group supports up to 100 workspace links");
  links.push(link);
  const updated = await BusinessGroup.findOneAndUpdate({ _id: group._id, revision: group.revision },
    { $set: { links }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  if (!updated) throw new HttpError(409, "Group changed. Refresh and retry");
  return { status: link.status };
}
async function decideLink(userId, groupId, workspaceId, requestId, decision) {
  if (!["approve", "reject", "revoke"].includes(decision) || typeof requestId !== "string" || requestId.length > 50) throw new HttpError(400, "Invalid link decision");
  const gid = objectId(groupId), wid = objectId(workspaceId);
  const workspace = await Workspace.findById(wid).select(workspaceFields).lean();
  const isOwner = workspace && usable(workspace) && ownerOf(workspace) === userId;
  if (!isOwner && !(decision === "revoke" && String(gid) === userId)) throw new HttpError(403, "Only the workspace owner can approve or reject; either owner can revoke");
  const match = { workspaceId: wid, requestId, status: { $in: decision === "revoke" ? ["pending", "active"] : ["pending"] },
    ...(decision !== "revoke" ? { ownerId: objectId(userId) } : {}) };
  const changed = await BusinessGroup.findOneAndUpdate({ _id: gid, links: { $elemMatch: match } }, {
    $set: { "links.$.status": { approve: "active", reject: "rejected", revoke: "revoked" }[decision],
      "links.$.decidedAt": new Date(), "links.$.decidedBy": objectId(userId) }, $inc: { revision: 1 },
  }, { new: true }).lean();
  if (!changed) throw new HttpError(409, "Request changed or is no longer actionable. Refresh and retry");
  return { success: true };
}
async function overview(userId) {
  const group = await BusinessGroup.findById(objectId(userId)).lean();
  if (!group) return { group: null };
  const current = await scope(userId);
  const allowed = new Set(current.links.map((l) => String(l.workspaceId)));
  return { group: { name: group.name, id: String(group._id), links: group.links.map((l) => ({
    workspaceId: String(l.workspaceId), requestId: l.requestId, status: l.status === "active" && !allowed.has(String(l.workspaceId)) ? "reapproval_required" : l.status,
    name: allowed.has(String(l.workspaceId)) ? current.workspaces.find((w) => String(w._id) === String(l.workspaceId))?.name : "Workspace " + String(l.workspaceId),
  })) } };
}
async function inbox(userId, workspaceId, after) {
  const wid = objectId(workspaceId);
  const workspace = await Workspace.findById(wid).select(workspaceFields).lean();
  if (!workspace || !usable(workspace) || ownerOf(workspace) !== userId) throw new HttpError(404, "Owned workspace not found");
  const groups = await BusinessGroup.find({ links: { $elemMatch: { workspaceId: wid, status: { $in: ["pending", "active"] } } },
    ...(after ? { _id: { $gt: objectId(after) } } : {}) }).sort({ _id: 1 }).limit(26).lean();
  return { next: groups.length > 25 ? String(groups[24]._id) : null,
    items: groups.slice(0, 25).map((g) => ({ groupId: String(g._id), groupName: g.name,
      ...g.links.find((l) => String(l.workspaceId) === String(wid)) })) };
}
module.exports = { ownedWorkspaces, getGroup, scope, saveGroup, requestLink, decideLink, overview, inbox };
