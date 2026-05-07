const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    apiKeyHash: { type: String, required: true, select: false, index: true },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorCodeHash: { type: String, select: false },
    twoFactorCodeExpiresAt: { type: Date, select: false },
    loginOtpCodeHash: { type: String, select: false },
    loginOtpCodeExpiresAt: { type: Date, select: false },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetTokenExpiresAt: { type: Date, select: false },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);

module.exports = { User };

