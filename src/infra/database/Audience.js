const mongoose = require("mongoose");

const AudienceConditionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["condition"], required: true, default: "condition" },
    field: { type: String, trim: true, required: true },
    fieldType: { type: String, trim: true, default: null },
    operator: { type: String, trim: true, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    secondaryValue: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const AudienceGroupSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["group"], required: true, default: "group" },
    operator: { type: String, enum: ["and", "or"], default: "and" },
    conditions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false }
);

const AudienceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    wabaId: { type: String, trim: true, required: true, index: true },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    description: { type: String, trim: true, default: "", maxlength: 500 },
    type: { type: String, enum: ["dynamic", "static"], required: true, index: true },
    filterTree: { type: AudienceGroupSchema, default: null },
    contactIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Contact" }], default: [] },
    contactCount: { type: Number, default: 0, min: 0 },
    lastRefreshedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    legacySource: {
      type: String,
      enum: ["contact_list", "audience_manager", "unknown"],
      default: "audience_manager",
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

AudienceSchema.index({ workspaceId: 1, wabaId: 1, createdAt: -1 });
AudienceSchema.index({ workspaceId: 1, wabaId: 1, name: 1 }, { unique: true });

const Audience = mongoose.model("Audience", AudienceSchema);

module.exports = {
  Audience,
  AudienceConditionSchema,
  AudienceGroupSchema,
};
