const mongoose = require("mongoose");

const BillingSettingsSchema = new mongoose.Schema(
  {
    currency: { type: String, default: "INR", enum: ["INR"] },
    defaultGstPercent: { type: Number, default: 18, min: 0, max: 100 },
    taxMode: { type: String, enum: ["exclusive"], default: "exclusive" },
    supplier: {
      legalName: { type: String, default: "" },
      tradeName: { type: String, default: "" },
      gstin: { type: String, default: "" },
      pan: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      stateCode: { type: String, default: "" },
      country: { type: String, default: "India" },
      pincode: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      website: { type: String, default: "" },
    },
    invoice: {
      prefix: { type: String, default: "INV" },
      nextSequence: { type: Number, default: 1, min: 1 },
      footerText: { type: String, default: "" },
      termsText: { type: String, default: "" },
      hsnSacCode: { type: String, default: "" },
      serviceDescription: { type: String, default: "SaaS Subscription" },
      signatureText: { type: String, default: "" },
    },
    freePlan: {
      name: { type: String, default: "Free" },
      description: { type: String, default: "Starter access with limited usage." },
      buttonText: { type: String, default: "Current Plan" },
      limits: {
        maxContacts: { type: Number, default: 10, min: 0 },
        maxTemplates: { type: Number, default: 5, min: 0 },
        maxCampaignsPerMonth: { type: Number, default: 3, min: 0 },
        maxContactsExport: { type: Number, default: 10, min: 0 },
      },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

const BillingSettings = mongoose.model("BillingSettings", BillingSettingsSchema);

module.exports = { BillingSettings };
