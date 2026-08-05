const mongoose = require("mongoose");

const AuthSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["user", "admin", "super_admin"], required: true, index: true },
    sessionId: { type: String, required: true, unique: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true, index: true, select: false },
    deviceIdHash: { type: String, required: true, index: true },
    workspaceId: { type: String, default: "" },
    trustedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
    lastUsedAt: { type: Date, default: Date.now },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    revokedAt: { type: Date, default: null, index: true },
    revokedReason: { type: String, default: "" },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

AuthSessionSchema.index({ userId: 1, deviceIdHash: 1, revokedAt: 1, expiresAt: 1 });

const AuthSession = mongoose.model("AuthSession", AuthSessionSchema);

module.exports = { AuthSession };
