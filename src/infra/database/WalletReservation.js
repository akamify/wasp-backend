const mongoose = require("mongoose");

const WalletReservationSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: { type: String, enum: ["held", "finalized", "released"], default: "held", index: true },
    category: { type: String, enum: ["marketing", "utility", "authentication", "unknown"], default: "unknown" },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null, index: true },
    walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    finalizedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WalletReservationSchema.index({ workspaceId: 1, status: 1, createdAt: 1 });

const WalletReservation = mongoose.model("WalletReservation", WalletReservationSchema);

module.exports = { WalletReservation };
