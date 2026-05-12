const mongoose = require("mongoose");

const ClickLogSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    linkId: { type: mongoose.Schema.Types.ObjectId, ref: "TrackedLink", index: true, default: null },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", index: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", index: true },
    url: { type: String, required: true },
    clickedAt: { type: Date, default: Date.now, index: true },
    ip: { type: String },
    userAgent: { type: String },
    referer: { type: String, default: null },
    source: { type: String, enum: ["link", "qr", "unknown"], default: "unknown", index: true },
  },
  { timestamps: true }
);

const ClickLog = mongoose.model("ClickLog", ClickLogSchema);

module.exports = { ClickLog };

