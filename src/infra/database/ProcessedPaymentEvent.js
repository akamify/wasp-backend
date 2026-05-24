const mongoose = require("mongoose");

const ProcessedPaymentEventSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ["razorpay"], required: true, index: true },
    eventId: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    paymentId: { type: String, default: "", index: true },
    orderId: { type: String, default: "", index: true },
    subscriptionId: { type: String, default: "", index: true },
    processedAt: { type: Date, default: Date.now, index: true },
    status: { type: String, default: "processed" },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

ProcessedPaymentEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

const ProcessedPaymentEvent = mongoose.model("ProcessedPaymentEvent", ProcessedPaymentEventSchema);

module.exports = { ProcessedPaymentEvent };

