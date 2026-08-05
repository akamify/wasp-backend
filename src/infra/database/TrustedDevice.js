const mongoose = require("mongoose");

const TrustedDeviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["user", "admin", "super_admin"], required: true, index: true },
    deviceIdHash: { type: String, required: true, index: true },
    trustedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    lastUsedAt: { type: Date, default: Date.now },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    revokedAt: { type: Date, default: null, index: true },
    revokedReason: { type: String, default: "" },
  },
  { timestamps: true }
);

TrustedDeviceSchema.index({ userId: 1, role: 1, deviceIdHash: 1 }, { unique: true });

const TrustedDevice = mongoose.model("TrustedDevice", TrustedDeviceSchema);

module.exports = { TrustedDevice };
