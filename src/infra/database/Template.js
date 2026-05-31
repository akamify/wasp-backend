const mongoose = require("mongoose");

const TemplateSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    // Templates belong to a WABA, not only to a workspace. A workspace can
    // reconnect to another WhatsApp account without inheriting stale templates.
    wabaId: { type: String, trim: true, index: true, default: null },
    name: { type: String, required: true, trim: true },
    language: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: ["marketing", "utility", "authentication"],
    },
    // WhatsApp expects components array as-is.
    components: { type: Array, required: true, default: [] },

    status: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected", "paused", "disabled"],
      default: "draft",
      index: true,
    },
    source: {
      type: String,
      enum: ["local", "meta"],
      default: "local",
    },
    metaTemplateId: { type: String, index: true },
    rejectedReason: { type: String },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

TemplateSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

const Template = mongoose.model("Template", TemplateSchema);

module.exports = { Template };
