const { CommerceOrder } = require("@infra/database/CommerceOrder");
const { CommercePayment } = require("@infra/database/CommercePayment");
const { Contact } = require("@infra/database/Contact");
const { scope } = require("./service");
const { reportFilter } = require("./policy");
const { HttpError } = require("@shared/utils/httpError");

const aggregate = (model, pipeline) => model.aggregate(pipeline).option({ maxTimeMS: 10000, allowDiskUse: true });
const fingerprint = ({ group, links }) => `${group.revision}:${links.map((l) => `${l.workspaceId}:${l.ownerId}:${l.requestId}`).sort().join(",")}`;
// Strip only the optional international '+' prefix. Never infer country codes.
const phoneKey = (field) => ({ $ltrim: { input: { $trim: { input: field } }, chars: "+" } });
function orderPipeline(match) {
  return [{ $match: match }, { $group: { _id: "$workspaceId", orders: { $sum: 1 },
    paidOrders: { $sum: { $cond: [{ $eq: ["$paymentStatus", "captured"] }, 1, 0] } },
    completedOrders: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
  } }];
}
async function report(userId, query) {
  const filter = reportFilter(query);
  const access = await scope(userId);
  const workspaceIds = access.links.map((l) => l.workspaceId);
  const match = { workspaceId: { $in: workspaceIds }, environment: filter.environment,
    receivedAt: { $gte: filter.start, $lt: filter.end } };
  const [counts, payments, customers, contacts, orders] = workspaceIds.length ? await Promise.all([
    aggregate(CommerceOrder, orderPipeline(match)),
    aggregate(CommercePayment, [{ $match: { workspaceId: { $in: workspaceIds }, environment: filter.environment,
      // Existing recovery records verified captures with capturedAt=null. createdAt
      // is the first local recording time, not a claimed provider capture time.
      status: "captured", createdAt: { $gte: filter.start, $lt: filter.end } } },
    { $group: { _id: { workspaceId: "$workspaceId", currency: "$currency" }, capturedPaise: { $sum: "$amountPaise" }, refundedPaise: { $sum: "$refundedPaise" } } }]),
    aggregate(CommerceOrder, [{ $match: match }, { $group: { _id: phoneKey("$customerPhone") } }, { $match: { _id: { $nin: ["", null] } } }, { $count: "count" }]),
    aggregate(Contact, [{ $match: { workspaceId: { $in: workspaceIds } } }, { $group: { _id: phoneKey("$phone") } }, { $match: { _id: { $nin: ["", null] } } }, { $count: "count" }]),
    CommerceOrder.find({ ...match, ...(filter.after ? { _id: { $lt: filter.after } } : {}) })
      .select("workspaceId orderNumber status paymentStatus totalPaise currency receivedAt")
      .sort({ _id: -1 }).limit(26).maxTimeMS(10000).lean(),
  ]) : [[], [], [], [], []];
  // A revoke/ownership change during an expensive report must discard its data.
  if (fingerprint(access) !== fingerprint(await scope(userId))) throw new HttpError(409, "Workspace access changed. Refresh the report");
  const rows = workspaceIds.map((id) => ({ workspaceId: String(id), name: access.workspaces.find((w) => String(w._id) === String(id))?.name,
    orders: 0, paidOrders: 0, completedOrders: 0, ...counts.find((c) => String(c._id) === String(id)),
    payments: payments.filter((p) => String(p._id.workspaceId) === String(id)).map((p) => ({ currency: p._id.currency, capturedPaise: p.capturedPaise, refundedPaise: p.refundedPaise })),
  }));
  return { environment: filter.environment, from: filter.start, to: filter.end, generatedAt: new Date(), rows,
    uniqueOrderCustomers: customers[0]?.count || 0, uniqueContactNumbers: contacts[0]?.count || 0,
    orders: orders.slice(0, 25), next: orders.length > 25 ? String(orders[24]._id) : null };
}
module.exports = { report, orderPipeline, fingerprint };
