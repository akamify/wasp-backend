const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    type: { type: String, enum: ["credit", "debit", "template_message_charge"], required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    reason: { type: String, required: true, trim: true },
    provider: { type: String, default: "internal" },
    providerRef: { type: String },
    meta: { type: Object },
  },
  { timestamps: true }
);

TransactionSchema.index({ workspaceId: 1, createdAt: -1 });

const Transaction = mongoose.model("Transaction", TransactionSchema);

module.exports = { Transaction };

