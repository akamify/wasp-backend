const mongoose = require("mongoose");

const InvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    financialYear: { type: String, required: true, index: true },
    sequence: { type: Number, required: true, min: 1 },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    planSlug: { type: String, required: true, index: true },
    planName: { type: String, required: true },
    status: {
      type: String,
      enum: ["generated", "generated_pending_pdf", "pdf_failed", "emailed", "email_failed", "cancelled", "void"],
      default: "generated_pending_pdf",
      index: true,
    },
    billingPeriod: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
      durationMonths: { type: Number, required: true },
    },
    supplierSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    customerSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    items: [{ type: mongoose.Schema.Types.Mixed }],
    amounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    payment: { type: mongoose.Schema.Types.Mixed, default: {} },
    pdf: { type: mongoose.Schema.Types.Mixed, default: {} },
    email: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

InvoiceSchema.index({ workspaceId: 1, createdAt: -1 });
InvoiceSchema.index({ subscriptionId: 1, "billingPeriod.start": 1, "billingPeriod.end": 1 }, { unique: true });
InvoiceSchema.index({ "payment.provider": 1, "payment.providerPaymentId": 1 }, { sparse: true });

const Invoice = mongoose.model("Invoice", InvoiceSchema);

module.exports = { Invoice };

