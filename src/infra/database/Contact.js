const mongoose = require("mongoose");

const ContactSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    phone: { type: String, required: true, index: true },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    company: { type: String, trim: true },
    language: { type: String, trim: true, default: null },
    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true }],
    attributes: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, index: true, default: null },
    source: {
      type: String,
      enum: ["manual", "inbound", "outbound", "imported"],
      default: "manual",
    },
    engagement: {
      interests: [{ type: String, trim: true }],
      engagementScore: { type: Number, default: 0, index: true },
      behaviour: [{ type: String, trim: true }],
      lastActivityAt: { type: Date, default: null, index: true },
      lastClickedAt: { type: Date, default: null },
      lastConversionAt: { type: Date, default: null },
      clickCount: { type: Number, default: 0 },
      conversionCount: { type: Number, default: 0 },
      totalRevenue: { type: Number, default: 0 },
      purchaseCount: { type: Number, default: 0 },
    },
    lastMessagePreview: { type: String },
    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },
  },
  { timestamps: true }
);

ContactSchema.index({ workspaceId: 1, wabaId: 1, phone: 1 }, { unique: true });
ContactSchema.index({ workspaceId: 1, wabaId: 1, tags: 1 });

const Contact = mongoose.model("Contact", ContactSchema);

module.exports = { Contact };
