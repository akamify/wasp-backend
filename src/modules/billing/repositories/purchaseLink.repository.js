const { PurchaseLink } = require("@infra/database/PurchaseLink");

async function createPurchaseLink(payload) {
  return PurchaseLink.create(payload);
}

async function listPurchaseLinksByWorkspace(workspaceId, { skip = 0, limit = 20 } = {}) {
  return PurchaseLink.find({ workspaceId }).sort({ createdAt: -1 }).skip(skip).limit(limit);
}

async function countPurchaseLinksByWorkspace(workspaceId) {
  return PurchaseLink.countDocuments({ workspaceId });
}

async function findPurchaseLinkById(id) {
  return PurchaseLink.findById(id);
}

async function cancelPurchaseLinkById(id) {
  return PurchaseLink.findByIdAndUpdate(
    id,
    { $set: { status: "cancelled" } },
    { new: true }
  );
}

module.exports = {
  createPurchaseLink,
  listPurchaseLinksByWorkspace,
  countPurchaseLinksByWorkspace,
  findPurchaseLinkById,
  cancelPurchaseLinkById,
};
