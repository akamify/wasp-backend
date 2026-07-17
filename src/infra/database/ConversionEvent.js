const mongoose = require("mongoose");

const ConversionEventSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null, index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null, index: true },
    assignedEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    phone: { type: String, trim: true, default: null, index: true },
    trackingToken: { type: String, trim: true, default: null, index: true },
    eventName: {
      type: String,
      enum: ["page_view", "signup", "lead_submit", "add_to_cart", "checkout_started", "purchase"],
      required: true,
      index: true,
    },
    value: { type: Number, default: 0 },
    currency: { type: String, trim: true, default: "INR" },
    metadata: { type: Object, default: {} },
    source: { type: String, enum: ["pixel", "server", "api"], required: true, index: true },
    dedupeKey: { type: String, trim: true, default: null, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ConversionEventSchema.index({ workspaceId: 1, timestamp: -1 });
ConversionEventSchema.index({ workspaceId: 1, contactId: 1, timestamp: -1 });
ConversionEventSchema.index({ workspaceId: 1, campaignId: 1, eventName: 1, timestamp: -1 });
ConversionEventSchema.index(
  { workspaceId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      dedupeKey: { $type: "string" },
    },
  }
);

const ConversionEvent = mongoose.model("ConversionEvent", ConversionEventSchema);

module.exports = { ConversionEvent };
