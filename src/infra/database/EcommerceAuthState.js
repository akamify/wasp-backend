const mongoose = require("mongoose");

const EcommerceAuthStateSchema = new mongoose.Schema(
  {
    stateHash: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    platform: { type: String, trim: true, lowercase: true, required: true, enum: ["shopify"] },
    shopDomain: { type: String, trim: true, lowercase: true, default: "" },
    purpose: { type: String, trim: true, default: "connect", enum: ["connect", "reconnect"] },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: "EcommerceStore", default: null },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

EcommerceAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
EcommerceAuthStateSchema.index({ workspaceId: 1, platform: 1, shopDomain: 1 });

const EcommerceAuthState =
  mongoose.models.EcommerceAuthState || mongoose.model("EcommerceAuthState", EcommerceAuthStateSchema);

module.exports = { EcommerceAuthState };
