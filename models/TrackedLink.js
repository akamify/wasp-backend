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
    message: { type: String, trim: true, default: "" },
    // WhatsApp display phone number (digits only, no +)
    waPhone: { type: String, trim: true, default: "" },
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

const TrackedLink = mongoose.model("TrackedLink", TrackedLinkSchema);

module.exports = { TrackedLink };
