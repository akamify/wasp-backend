const { CommerceCatalogConnection: Catalog } = require("@infra/database/CommerceCatalogConnection");
const { CommerceProduct: Product } = require("@infra/database/CommerceProduct");
const { byWorkspace } = require("./scope");
const { MAX_BATCH, LEASE_MS } = require("../domain/catalog");

const unlocked = (now) => ({ $or: [{ syncLeaseUntil: null }, { syncLeaseUntil: { $lte: now } }] });
const due = (now) => ({ syncStatus: { $in: ["pending", "accepted"] }, syncNextAttemptAt: { $lte: now }, ...unlocked(now) });
function activeCatalog(workspaceId, wabaId) {
  return Catalog.findOne(byWorkspace(workspaceId, { wabaId, active: true })).lean();
}
function historicalCatalog(workspaceId, scope) {
  return Catalog.findOne(byWorkspace(workspaceId, scope)).lean();
}
function createCatalog(fields) { return Catalog.create(fields); }
function reactivateCatalog(workspaceId, id, revision, fields) {
  return Catalog.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, revision, active: false }),
    { $set: { ...fields, active: true }, $inc: { revision: 1 } }, { returnDocument: "after", runValidators: true }).lean();
}
function claimCatalog(workspaceId, id, owner, now) {
  return Catalog.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, active: true, ...unlocked(now) }),
    { $set: { syncLeaseOwner: owner, syncLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { returnDocument: "after" }).lean();
}
function holdsCatalog(workspaceId, id, owner, now) {
  return Catalog.exists(byWorkspace(workspaceId, { _id: id, active: true, syncLeaseOwner: owner, syncLeaseUntil: { $gt: now } }));
}
function releaseCatalog(workspaceId, id, owner) {
  return Catalog.updateOne(byWorkspace(workspaceId, { _id: id, syncLeaseOwner: owner }),
    { $set: { syncLeaseOwner: "", syncLeaseUntil: null } });
}
function updateCatalog(workspaceId, id, owner, revision, patch) {
  return Catalog.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, syncLeaseOwner: owner, revision }),
    { $set: patch, $inc: { revision: 1 } }, { returnDocument: "after", runValidators: true }).lean();
}
function listProducts(workspaceId, catalogConnectionId, { limit, cursor, archived }) {
  return Product.find(byWorkspace(workspaceId, {
    catalogConnectionId, archivedAt: archived ? { $ne: null } : null,
    ...(cursor ? { _id: { $lt: cursor } } : {}),
  })).sort({ _id: -1 }).limit(limit + 1).lean();
}
function findProduct(workspaceId, catalogConnectionId, id) {
  return Product.findOne(byWorkspace(workspaceId, { _id: id, catalogConnectionId })).lean();
}
function createProduct(fields) { return Product.create(fields); }
function updateProduct(workspaceId, product, patch) {
  return Product.findOneAndUpdate(byWorkspace(workspaceId, {
    _id: product._id, catalogConnectionId: product.catalogConnectionId, revision: product.revision,
    stockReserved: product.stockReserved, syncSubmittedRevision: product.syncSubmittedRevision,
    syncedRevision: product.syncedRevision,
  }), { $set: patch, $inc: { revision: 1 } }, { returnDocument: "after", runValidators: true }).lean();
}
function retryProduct(workspaceId, product, patch) {
  return Product.findOneAndUpdate(byWorkspace(workspaceId, {
    _id: product._id, revision: product.revision, syncSubmittedRevision: product.syncSubmittedRevision,
    syncedRevision: product.syncedRevision, ...unlocked(new Date()),
  }), { $set: patch }, { returnDocument: "after", runValidators: true }).lean();
}
function findCandidates(now) {
  return Product.find(due(now)).sort({ syncNextAttemptAt: 1 }).limit(100).select("workspaceId catalogConnectionId").lean();
}
function catalogExists(workspaceId, id) {
  return Catalog.exists(byWorkspace(workspaceId, { _id: id, active: true }));
}
async function claimProducts(workspaceId, catalogConnectionId, owner, now) {
  const filter = byWorkspace(workspaceId, { catalogConnectionId, ...due(now) });
  const selected = await Product.find(filter).sort({ syncNextAttemptAt: 1 }).limit(MAX_BATCH).select("_id").lean();
  if (!selected.length) return [];
  await Product.updateMany(byWorkspace(workspaceId, { _id: { $in: selected.map((product) => product._id) }, ...due(now) }),
    { $set: { syncLeaseOwner: owner, syncLeaseUntil: new Date(now.getTime() + LEASE_MS) } });
  return Product.find(byWorkspace(workspaceId, { catalogConnectionId, syncLeaseOwner: owner })).limit(MAX_BATCH).lean();
}
function syncProduct(workspaceId, product, owner, patch) {
  return Product.findOneAndUpdate(byWorkspace(workspaceId, {
    _id: product._id, revision: product.revision, syncLeaseOwner: owner,
    syncLeaseUntil: { $gt: new Date() }, syncSubmittedRevision: product.syncSubmittedRevision,
  }), { $set: patch }, { returnDocument: "after", runValidators: true }).lean();
}
function releaseProducts(workspaceId, catalogConnectionId, owner) {
  return Product.updateMany(byWorkspace(workspaceId, { catalogConnectionId, syncLeaseOwner: owner }),
    { $set: { syncLeaseOwner: "", syncLeaseUntil: null } });
}
function deferCatalog(workspaceId, catalogConnectionId, now) {
  return Product.updateMany(byWorkspace(workspaceId, { catalogConnectionId, ...due(now) }),
    { $set: { syncNextAttemptAt: new Date(now.getTime() + 3600000), syncError: "Catalog connection is unavailable. Reconnect the original WhatsApp account." } });
}
module.exports = { activeCatalog, historicalCatalog, createCatalog, reactivateCatalog, claimCatalog, holdsCatalog,
  releaseCatalog, updateCatalog, listProducts, findProduct, createProduct, updateProduct, retryProduct,
  findCandidates, catalogExists, claimProducts, syncProduct, releaseProducts, deferCatalog };
