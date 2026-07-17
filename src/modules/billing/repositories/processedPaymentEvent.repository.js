const { ProcessedPaymentEvent } = require("@infra/database/ProcessedPaymentEvent");

async function createProcessedEvent(payload) {
  return ProcessedPaymentEvent.create(payload);
}

async function claimEvent(payload) {
  const filter = { provider: payload.provider, eventId: payload.eventId };
  const existing = await ProcessedPaymentEvent.findOne(filter);
  if (existing && existing.status !== "failed") return { duplicate: true, event: existing };
  if (existing && existing.status === "failed") {
    existing.eventType = payload.eventType;
    existing.paymentId = payload.paymentId || "";
    existing.orderId = payload.orderId || "";
    existing.subscriptionId = payload.subscriptionId || "";
    existing.status = "processing";
    existing.error = "";
    existing.processedAt = new Date();
    await existing.save();
    return { duplicate: false, event: existing };
  }
  const event = await ProcessedPaymentEvent.create({ ...payload, status: "processing" });
  return { duplicate: false, event };
}

async function markProcessed(id, patch = {}) {
  return ProcessedPaymentEvent.findByIdAndUpdate(
    id,
    { $set: { ...patch, status: "processed", error: "" } },
    { new: true }
  );
}

async function markFailed(id, error) {
  return ProcessedPaymentEvent.findByIdAndUpdate(
    id,
    { $set: { status: "failed", error: String(error || "processing_failed").slice(0, 500) } },
    { new: true }
  );
}

module.exports = { createProcessedEvent, claimEvent, markProcessed, markFailed };

