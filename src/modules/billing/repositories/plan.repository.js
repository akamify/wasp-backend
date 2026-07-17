const { Plan } = require("@infra/database/Plan");
const { PLAN_STATUSES } = require("@modules/billing/constants/planStatuses");
const mongoose = require("mongoose");

function findById(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) return null;
  return Plan.findOne({ _id: id, deletedAt: null });
}

function findBySlug(slug) {
  return Plan.findOne({ slug: String(slug || "").trim().toLowerCase(), deletedAt: null });
}

function listPublicPlans() {
  return Plan.find({
    status: PLAN_STATUSES.PUBLISHED,
    publicVisible: true,
    purchasable: true,
    deletedAt: null,
  }).sort({ sortOrder: 1, createdAt: -1 });
}

function clearRecommendedExcept(planId) {
  if (!planId) return Promise.resolve();
  return Plan.updateMany(
    { _id: { $ne: planId }, deletedAt: null, recommended: true },
    { $set: { recommended: false } }
  );
}

module.exports = {
  findById,
  findBySlug,
  listPublicPlans,
  clearRecommendedExcept,
};

