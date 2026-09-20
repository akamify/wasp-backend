const { randomUUID } = require("node:crypto");
const repo = require("./repository");
const service = require("./service");
const routing = require("./routing");
const settings = require("./routingSettings");
const orders = require("../repositories/orders.repository");
const modes = { SMART: "smart", NEAREST_PICKUP: "nearest_pickup", NEAREST_CUSTOMER: "nearest_customer" };
const MAX_ATTEMPTS = 5, RETRY_MS = 60000, BATCH_SIZE = 10;
const due = (now) => ({ status: "awaiting_rider", autoDispatchPaused: { $ne: true },
  $or: [{ autoNextAttemptAt: null }, { autoNextAttemptAt: { $lte: now } }] });
function pipeline(now) {
  return [{ $match: due(now) }, { $sort: { autoNextAttemptAt: 1, _id: 1 } },
    { $lookup: { from: repo.RoutingSettings.collection.name, localField: "workspaceId", foreignField: "workspaceId",
      pipeline: [{ $match: { autoDispatch: true, strategy: { $ne: "MANUAL" } } }, { $project: { _id: 1 } }], as: "dispatchSettings" } },
    { $match: { "dispatchSettings.0": { $exists: true } } }, { $limit: BATCH_SIZE },
    { $project: { _id: 1, workspaceId: 1, revision: 1 } }];
}
async function dispatch(row) {
  if (!settings.autoEnabled()) return "disabled";
  const now = new Date();
  // Durable claim survives worker crashes; another worker can retry after one minute.
  const r = await repo.Delivery.findOneAndUpdate({ ...due(now), _id: row._id, workspaceId: row.workspaceId, revision: row.revision },
    { $set: { autoNextAttemptAt: new Date(now.getTime() + RETRY_MS) }, $inc: { autoAttempts: 1 } },
    { new: true, writeConcern: { w: "majority", j: true, wtimeout: 10000 } }).lean();
  if (!r) return "claimed_elsewhere";
  if (r.autoAttempts > MAX_ATTEMPTS) {
    return await service.dispatchFailure(r, "Automatic attempts exhausted. Assign a rider manually or resume dispatch.") ? "exhausted" : "superseded";
  }
  try {
    const config = await settings.get(r.workspaceId);
    if (!config.autoDispatch || !modes[config.strategy] || !await orders.workspaceActive(r.workspaceId)) return "disabled";
    if (require("./batching").enabled()) return await require("./batching").automatic(r);
    const result = await routing.recommend(r.workspaceId, r._id, { revision: r.revision, mode: modes[config.strategy] }, { automatic: true });
    const best = result.candidates[0];
    if (!best) {
      if (result.unavailableReason === "routing_unavailable") throw new Error("Routing unavailable");
      return await service.dispatchFailure(r, "No eligible rider with a valid route. Check GPS and assign a rider manually.") ? "awaiting_manual_assignment" : "superseded";
    }
    await service.offer(r.workspaceId, r._id, { revision: r.revision, courierId: best.courierId, idempotencyKey: randomUUID() }, "system:auto-dispatch",
      { settingsRevision: result.settingsRevision, expiresAt: result.expiresAt, gpsAt: best.gpsAt, vehicle: best.vehicle });
    return "offered";
  } catch {
    const terminal = r.autoAttempts >= MAX_ATTEMPTS;
    const changed = await service.dispatchFailure(r, terminal ? "Automatic dispatch failed after bounded retries. Assign a rider manually."
      : "Automatic dispatch could not complete. A delayed retry is scheduled; manual control remains available.", terminal);
    return changed ? terminal ? "awaiting_manual_assignment" : "retry_pending" : "superseded";
  }
}
async function run() {
  if (!settings.autoEnabled()) return { disabled: true };
  await require("./readiness").autoReady();
  const rows = await repo.Delivery.aggregate(pipeline(new Date())).option({ maxTimeMS: 3000 });
  const results = {};
  // Bounded parallelism; each delivery has its own durable claim and atomic rider reservation.
  for (let i = 0; i < rows.length; i += 2) await Promise.all(rows.slice(i, i + 2).map(async (r) => {
    let outcome;
    try { outcome = await dispatch(r); }
    catch { outcome = "retry_pending"; } // No upstream errors, GPS or credentials in job logs.
    results[outcome] = (results[outcome] || 0) + 1;
  }));
  if (results.retry_pending) require("@core/logger/logger").warn("Automatic dispatch has pending retries", { event: "delivery_auto_retry", count: results.retry_pending });
  return results;
}
module.exports = { run, dispatch, pipeline, MAX_ATTEMPTS, RETRY_MS, BATCH_SIZE };
