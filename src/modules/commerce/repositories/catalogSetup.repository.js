const { CommerceCatalogSetup: Setup } = require("@infra/database/CommerceCatalogSetup");
const { byWorkspace } = require("./scope");
const key = (workspaceId, wabaId) => `${workspaceId}:${wabaId}`;
const filter = (workspaceId, wabaId) => byWorkspace(workspaceId, { _id: key(workspaceId, wabaId) });
const read = (workspaceId, wabaId) => Setup.findOne(filter(workspaceId, wabaId)).lean();
async function ensure(workspaceId, fields) {
  filter(workspaceId, fields.wabaId);
  try { await Setup.create({ _id: key(workspaceId, fields.wabaId), workspaceId, ...fields }); }
  catch (error) { if (error.code !== 11000) throw error; }
  return read(workspaceId, fields.wabaId);
}
function claim(workspaceId, wabaId, owner) {
  return Setup.findOneAndUpdate({ ...filter(workspaceId, wabaId),
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] },
  { $set: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 180000) } }, { returnDocument: "after" }).lean();
}
function save(workspaceId, wabaId, owner, patch) {
  return Setup.findOneAndUpdate({ ...filter(workspaceId, wabaId), leaseOwner: owner, leaseUntil: { $gt: new Date() } },
    { $set: patch }, { returnDocument: "after", runValidators: true }).lean();
}
function release(workspaceId, wabaId, owner) {
  return Setup.updateOne({ ...filter(workspaceId, wabaId), leaseOwner: owner }, { $set: { leaseOwner: "", leaseUntil: null } });
}
module.exports = { read, ensure, claim, save, release };
