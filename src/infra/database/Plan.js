const mongoose = require("mongoose");

const PlanSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    name: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: "" },
    pricing: {
      currency: { type: String, default: "INR" },
      originalPricePaise: { type: Number, default: null, min: 0 },
      discountedPricePaise: { type: Number, default: null, min: 0 },
      gstPercent: { type: Number, default: 18, min: 0, max: 100 },
      taxMode: { type: String, enum: ["exclusive"], default: "exclusive" },
    },
    computedPreviewSnapshot: {
      discountAmountPaise: { type: Number, default: 0 },
      discountPercent: { type: Number, default: 0 },
      gstAmountPaise: { type: Number, default: 0 },
      payableAmountPaise: { type: Number, default: 0 },
    },
    buttonText: { type: String, default: "" },
    badgeText: { type: String, default: "" },
    status: { type: String, enum: ["draft", "in_review", "published", "archived", "disabled"], default: "in_review", index: true },
    publicVisible: { type: Boolean, default: true, index: true },
    purchasable: { type: Boolean, default: true, index: true },
    recommended: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 1, min: 1, max: 5, index: true },
    features: {
      dashboardPageAccess: { type: Boolean, default: false },
      templatesPageAccess: { type: Boolean, default: false },
      campaignsPageAccess: { type: Boolean, default: false },
      contactsPageAccess: { type: Boolean, default: false },
      inboxPageAccess: { type: Boolean, default: false },
      crmPageAccess: { type: Boolean, default: false },
      flowsPageAccess: { type: Boolean, default: false },
      walletPageAccess: { type: Boolean, default: false },
      linksPageAccess: { type: Boolean, default: false },
      automationPageAccess: { type: Boolean, default: false },
      activityPageAccess: { type: Boolean, default: false },
      apiKeysPageAccess: { type: Boolean, default: false },
      apiReportsPageAccess: { type: Boolean, default: false },
      campaignApiAccess: { type: Boolean, default: false },
      externalChatApiAccess: { type: Boolean, default: false },
      crmAccess: { type: Boolean, default: false },
      employeeAccess: { type: Boolean, default: false },
      leadDistributionAccess: { type: Boolean, default: false },
      analyticsAccess: { type: Boolean, default: false },
      exportAccess: { type: Boolean, default: false },
      automationAccess: { type: Boolean, default: false },
      apiKeyAccess: { type: Boolean, default: false },
    },
    limits: {
      maxContacts: { type: Number, default: 0 },
      maxTemplates: { type: Number, default: 0 },
      maxEmployees: { type: Number, default: 0 },
      maxApiKeys: { type: Number, default: 0 },
      maxCampaignsPerMonth: { type: Number, default: 0 },
      maxContactsExport: { type: Number, default: 0 },
      // Backward compatibility for older plans. New plans should use `maxContactsExport`.
      maxExportsPerMonth: { type: Number, default: 0 },
      maxStorageMb: { type: Number, default: 0 },
    },
    entitlements: { type: mongoose.Schema.Types.Mixed, default: {} },
    featureRows: [
      {
        label: { type: String, required: true, trim: true },
        type: { type: String, enum: ["functionality", "limit", "text"], required: true },
        functionalityKey: { type: String, default: "" },
        limitKey: { type: String, default: "" },
        value: { type: mongoose.Schema.Types.Mixed, default: null },
        included: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 0 },
      },
    ],
    displayFeatures: [{ type: String, trim: true }],
    unavailableFeatures: [{ type: String, trim: true }],
    review: {
      submittedAt: { type: Date, default: null },
      publishedAt: { type: Date, default: null },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      reviewNote: { type: String, default: "" },
    },
    version: { type: Number, default: 1, min: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

PlanSchema.pre("save", function () {
  if (!this.isNew && this.isModified()) {
    this.version = Number(this.version || 1) + 1;
  }
});

const Plan = mongoose.model("Plan", PlanSchema);

module.exports = { Plan };
