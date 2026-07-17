const mongoose = require("mongoose");

const TrackedLinkSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    title: { type: String, trim: true, default: "" },
    kind: { type: String, enum: ["whatsapp", "redirect"], default: "whatsapp", index: true },
    trackingToken: { type: String, trim: true, default: null, index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null, index: true },
    message: { type: String, trim: true, default: "" },
    // WhatsApp display phone number (digits only, no +)
    waPhone: { type: String, trim: true, default: "" },
    originalUrl: { type: String, default: null },
    // Final WhatsApp redirect URL (wa.me/PHONE?text=...)
    redirectUrl: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    clicks: { type: Number, default: 0 },
    scans: { type: Number, default: 0 },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

TrackedLinkSchema.index({ workspaceId: 1, createdAt: -1 });
TrackedLinkSchema.index(
  { workspaceId: 1, trackingToken: 1 },
  {
    unique: true,
    partialFilterExpression: {
      trackingToken: { $type: "string" },
    },
  }
);

const TrackedLink = mongoose.model("TrackedLink", TrackedLinkSchema);

module.exports = { TrackedLink };
