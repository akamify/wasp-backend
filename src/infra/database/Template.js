const mongoose = require("mongoose");

const TemplateSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: false,
      default: null,
      index: true,
    },
    ownerType: {
      type: String,
      enum: ["system", "workspace"],
      default: "workspace",
      index: true,
    },
    // Templates belong to a WABA, not only to a workspace. A workspace can
    // reconnect to another WhatsApp account without inheriting stale templates.
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, default: null },
    name: { type: String, required: true, trim: true },
    language: { type: String, required: true, trim: true },
    languageCode: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: ["marketing", "utility", "authentication"],
    },
    // WhatsApp expects components array as-is.
    components: { type: Array, required: true, default: [] },

    status: {
      type: String,
      enum: ["draft", "published", "archived", "pending", "approved", "rejected", "paused", "disabled"],
      default: "draft",
      index: true,
    },
    libraryCategory: { type: String, trim: true, default: null, index: true },
    industry: { type: String, trim: true, default: null, index: true },
    templatePackKey: { type: String, trim: true, default: null, index: true },
    templatePackName: { type: String, trim: true, default: null, index: true },
    templatePackOrder: { type: Number, default: 0, index: true },
    tags: [{ type: String, trim: true }],
    featured: { type: Boolean, default: false, index: true },
    thumbnail: { type: String, trim: true, default: null },
    sourceTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Template",
      default: null,
      index: true,
    },
    favoriteWorkspaces: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
    }],
    isOfficial: { type: Boolean, default: false, index: true },
    popularity: { type: Number, default: 0, min: 0 },
    source: {
      type: String,
      enum: ["local", "meta"],
      default: "local",
    },
    metaTemplateId: { type: String, index: true },
    isActive: { type: Boolean, default: true, index: true },
    syncedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null, index: true },
    staleReason: { type: String, default: null },
    rejectedReason: { type: String },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

TemplateSchema.index({ workspaceId: 1, wabaId: 1, name: 1, languageCode: 1 }, { unique: true });
TemplateSchema.index({ ownerType: 1, status: 1, featured: -1, updatedAt: -1 });
TemplateSchema.index({ ownerType: 1, libraryCategory: 1, industry: 1, updatedAt: -1 });
TemplateSchema.index({ ownerType: 1, status: 1, templatePackKey: 1, templatePackOrder: 1, updatedAt: -1 });

const Template = mongoose.model("Template", TemplateSchema);

module.exports = { Template };
