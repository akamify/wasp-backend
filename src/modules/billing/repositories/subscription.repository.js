const { Subscription } = require("@infra/database/Subscription");

async function findActiveByWorkspace(workspaceId) {
  return Subscription.findOne({
    workspaceId,
    status: { $in: ["active", "past_due", "cancelled"] },
  }).sort({ createdAt: -1 });
}

async function findLatestByWorkspace(workspaceId) {
  return Subscription.findOne({ workspaceId }).sort({ createdAt: -1 });
}

async function listByWorkspace(workspaceId, { skip = 0, limit = 20, query = null } = {}) {
  const filter = { workspaceId };
  if (query) {
    const rx = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ planName: rx }, { planSlug: rx }, { status: rx }, { paymentMode: rx }];
  }
  return Subscription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
}

async function countByWorkspace(workspaceId, { query = null } = {}) {
  const filter = { workspaceId };
  if (query) {
    const rx = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ planName: rx }, { planSlug: rx }, { status: rx }, { paymentMode: rx }];
  }
  return Subscription.countDocuments(filter);
}

async function createSubscription(payload) {
  return Subscription.create(payload);
}

module.exports = {
  findActiveByWorkspace,
  findLatestByWorkspace,
  listByWorkspace,
  countByWorkspace,
  createSubscription,
};
