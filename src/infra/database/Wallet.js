const mongoose = require("mongoose");

const WalletSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
    },
    balance: { type: Number, default: 0 }, // INR
    currency: { type: String, default: "INR" },
  },
  { timestamps: true }
);

const Wallet = mongoose.model("Wallet", WalletSchema);

module.exports = { Wallet };

