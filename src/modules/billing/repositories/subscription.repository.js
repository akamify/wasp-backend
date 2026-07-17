const { Subscription } = require("@infra/database/Subscription");

async function findActiveByWorkspace(workspaceId, options = {}) {
  return Subscription.findOne({
    workspaceId,
    status: { $in: ["active", "past_due", "grace_period"] },
  }).sort({ createdAt: -1 }).session(options.session || null);
}

async function findLatestByWorkspace(workspaceId) {
  return Subscription.findOne({ workspaceId }).sort({ createdAt: -1 });
}

async function findById(id, options = {}) {
  return Subscription.findById(id).session(options.session || null);
}

async function findPaymentDueByWorkspace(workspaceId) {
  return Subscription.findOne({
    workspaceId,
    status: "payment_due",
  }).sort({ createdAt: -1 });
}

async function findByRazorpaySubscriptionId(razorpaySubscriptionId) {
  return Subscription.findOne({
    razorpaySubscriptionId: String(razorpaySubscriptionId || ""),
  }).sort({ createdAt: -1 });
}

async function listExpiredActive(now, { limit = 100 } = {}) {
  return Subscription.find({
    status: { $in: ["active", "past_due"] },
    currentPeriodEnd: { $lte: now },
    $or: [{ lifecycleLockUntil: null }, { lifecycleLockUntil: { $lte: now } }],
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(limit);
}

async function claimLifecycleLock(id, now, lockUntil) {
  return Subscription.findOneAndUpdate(
    {
      _id: id,
      $or: [{ lifecycleLockUntil: null }, { lifecycleLockUntil: { $lte: now } }],
    },
    { $set: { lifecycleLockedAt: now, lifecycleLockUntil: lockUntil } },
    { new: true }
  );
}

async function releaseLifecycleLock(id) {
  return Subscription.findByIdAndUpdate(
    id,
    { $set: { lifecycleLockUntil: null, lifecycleLockedAt: null } },
    { new: true }
  );
}

async function listExpiredGrace(now, { limit = 100 } = {}) {
  return Subscription.find({
    status: "grace_period",
    gracePeriodEndsAt: { $lte: now },
    $or: [{ lifecycleLockUntil: null }, { lifecycleLockUntil: { $lte: now } }],
  })
    .sort({ gracePeriodEndsAt: 1 })
    .limit(limit);
}

async function listAutoRenewDue(now, { lookaheadMs = 24 * 60 * 60 * 1000, limit = 100 } = {}) {
  const until = new Date(now.getTime() + lookaheadMs);
  return Subscription.find({
    status: "active",
    autoRenewEnabled: true,
    currentPeriodEnd: { $lte: until },
    $or: [
      { renewalStatus: { $in: ["", "none", "scheduled", "retry_scheduled"] } },
      { nextRenewalAttemptAt: { $lte: now } },
    ],
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(limit);
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

async function createSubscription(payload, options = {}) {
  if (options.session) {
    const docs = await Subscription.create([payload], { session: options.session });
    return docs[0];
  }
  return Subscription.create(payload);
}

async function cancelActiveByWorkspace(workspaceId, patch = {}, options = {}) {
  return Subscription.updateMany(
    {
      workspaceId,
      status: { $in: ["active", "past_due", "grace_period"] },
    },
    {
      $set: {
        ...patch,
        status: patch.status || "cancelled",
        cancelAtPeriodEnd: false,
      },
    },
    { session: options.session }
  );
}

module.exports = {
  findActiveByWorkspace,
  findLatestByWorkspace,
  findById,
  findPaymentDueByWorkspace,
  findByRazorpaySubscriptionId,
  listExpiredActive,
  claimLifecycleLock,
  releaseLifecycleLock,
  listExpiredGrace,
  listAutoRenewDue,
  listByWorkspace,
  countByWorkspace,
  createSubscription,
  cancelActiveByWorkspace,
};
