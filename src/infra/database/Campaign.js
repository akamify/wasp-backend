const mongoose = require("mongoose");

const CampaignRecipientSnapshotSchema = new mongoose.Schema(
  {
    to: { type: String, required: true, trim: true },
    variables: [{ type: String, default: "" }],
    headerVariables: [{ type: String, default: "" }],
    otpCode: { type: String, default: "" },
    buttonValues: [{ type: String, default: "" }],
    buttonTtlMinutes: [{ type: Number }],
    flowTokens: [{ type: String, default: "" }],
    flowActionData: [{ type: mongoose.Schema.Types.Mixed }],
  },
  { _id: false }
);

const CampaignRuntimeSnapshotSchema = new mongoose.Schema(
  {
    variables: [{ type: String, default: "" }],
    headerVariables: [{ type: String, default: "" }],
    otpCode: { type: String, default: "" },
    buttonValues: [{ type: String, default: "" }],
    buttonTtlMinutes: [{ type: Number }],
    flowTokens: [{ type: String, default: "" }],
    flowActionData: [{ type: mongoose.Schema.Types.Mixed }],
  },
  { _id: false }
);

const VariableMappingSchema = new mongoose.Schema(
  {
    position: { type: Number, required: true, min: 1, max: 20 },
    sourceType: { type: String, enum: ["static", "contact_field", "contact_attribute"], required: true },
    sourceKey: { type: String, trim: true },
    value: { type: String, default: "" },
    fallback: { type: String, default: "" },
  },
  { _id: false }
);

const AttributeFilterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    operator: { type: String, enum: ["equals", "not_equals", "exists", "not_exists", "contains"], required: true },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const CampaignSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, index: true, default: null },
    name: { type: String, required: true, trim: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true, index: true },
    type: {
      type: String,
      enum: ["broadcast", "csv", "api"],
      default: "broadcast",
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "queued", "running", "completed", "failed", "paused", "canceled", "cancelled"],
      default: "draft",
      index: true,
    },
    scheduledAt: { type: Date },
    audience: {
      mode: {
        type: String,
        enum: ["manual", "tags", "attributes"],
        default: "manual",
        index: true,
      },
      tags: [{ type: String, trim: true }],
      tagMatch: {
        type: String,
        enum: ["all", "any"],
        default: "all",
      },
      attributeFilters: [AttributeFilterSchema],
      runtime: CampaignRuntimeSnapshotSchema,
    },
    templateVariableMappings: [VariableMappingSchema],
    headerVariableMappings: [VariableMappingSchema],
    buttonVariableMappings: [VariableMappingSchema],
    schedule: {
      frequency: {
        type: String,
        enum: ["once", "daily", "weekly"],
        default: "once",
        index: true,
      },
      status: {
        type: String,
        enum: ["inactive", "active", "completed", "canceled"],
        default: "inactive",
        index: true,
      },
      startAt: { type: Date },
      endAt: { type: Date },
      nextRunAt: { type: Date, index: true },
      lastRunAt: { type: Date },
      maxOccurrences: { type: Number, min: 1 },
      occurrencesRun: { type: Number, default: 0, min: 0 },
    },
    recipientSnapshot: [CampaignRecipientSnapshotSchema],
    totals: {
      total: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    lastError: { type: Object },
  },
  { timestamps: true }
);

CampaignSchema.index({ workspaceId: 1, createdAt: -1 });
CampaignSchema.index({ workspaceId: 1, wabaId: 1, createdAt: -1 });
CampaignSchema.index({ "schedule.status": 1, "schedule.nextRunAt": 1 });

const Campaign = mongoose.model("Campaign", CampaignSchema);

module.exports = { Campaign };
