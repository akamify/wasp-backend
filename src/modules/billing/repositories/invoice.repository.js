const { Invoice } = require("@infra/database/Invoice");

async function createInvoice(payload, options = {}) {
  if (options.session) {
    const docs = await Invoice.create([payload], { session: options.session });
    return docs[0];
  }
  return Invoice.create(payload);
}

async function findById(id, options = {}) {
  return Invoice.findById(id).session(options.session || null);
}

async function findPendingRenewalByWorkspace(workspaceId) {
  return Invoice.findOne({
    workspaceId,
    renewalType: { $in: ["scheduled_downgrade", "renewal"] },
    paymentStatus: "pending",
    status: "pending",
  }).sort({ createdAt: -1 });
}

async function markPaymentPending(id, patch = {}, options = {}) {
  return Invoice.findByIdAndUpdate(
    id,
    {
      $set: {
        ...patch,
        status: "pending",
        paymentStatus: "pending",
      },
      $inc: { "payment.retryCount": 1 },
    },
    { new: true, session: options.session }
  );
}

async function markPaid(id, patch = {}, options = {}) {
  return Invoice.findByIdAndUpdate(
    id,
    {
      $set: {
        ...patch,
        status: "paid",
        paymentStatus: "paid",
      },
    },
    { new: true, session: options.session }
  );
}

async function markFailed(id, patch = {}, options = {}) {
  return Invoice.findByIdAndUpdate(
    id,
    {
      $set: {
        ...patch,
        status: "failed",
        paymentStatus: "failed",
      },
    },
    { new: true, session: options.session }
  );
}

async function markExpired(id, patch = {}, options = {}) {
  return Invoice.findByIdAndUpdate(
    id,
    {
      $set: {
        ...patch,
        status: "expired",
        paymentStatus: "expired",
      },
    },
    { new: true, session: options.session }
  );
}

async function listByWorkspace(workspaceId, { skip = 0, limit = 20 } = {}) {
  return Invoice.find({ workspaceId }).sort({ createdAt: -1 }).skip(skip).limit(limit);
}

async function countByWorkspace(workspaceId) {
  return Invoice.countDocuments({ workspaceId });
}

module.exports = {
  createInvoice,
  findById,
  findPendingRenewalByWorkspace,
  markPaymentPending,
  markPaid,
  markFailed,
  markExpired,
  listByWorkspace,
  countByWorkspace,
};

