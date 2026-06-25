const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    role: { type: String, enum: ["user", "admin", "super_admin"], default: "user" },
    status: { type: String, enum: ["active", "banned", "fired", "retired"], default: "active", index: true },
    terminationState: { type: String, enum: ["", "retired", "fired"], default: "" },
    apiKeyHash: { type: String, default: null, select: false, index: true },
    apiKeyEnc: { type: String, default: null, select: false },
    apiKeys: [
      {
        workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", index: true, default: null },
        wabaId: { type: String, trim: true, index: true, default: null },
        name: { type: String, trim: true },
        keyPrefix: { type: String, trim: true, index: true },
        keyHash: { type: String, required: true, select: false },
        keyEnc: { type: String, default: null, select: false },
        permissions: {
          campaignSend: { type: Boolean, default: true },
          chatAccess: { type: Boolean, default: false },
          scopes: [{ type: String, trim: true }],
        },
        status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
        revoked: { type: Boolean, default: false },
        revokedAt: { type: Date },
        lastUsedAt: { type: Date },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    allowedApiPermissions: {
      campaignSend: { type: Boolean, default: true },
      chatAccess: { type: Boolean, default: false },
    },
    adminPermissions: {
      pages: [{ type: String, trim: true }],
      components: [{ type: String, trim: true }],
      actions: [{ type: String, trim: true }],
    },
    accountBlocked: { type: Boolean, default: false, index: true },
    tokenVersion: { type: Number, default: 0 },
    chatAccessEnabledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    chatAccessEnabledAt: { type: Date },
    apiKeyOtpCodeHash: { type: String, select: false },
    apiKeyOtpCodeExpiresAt: { type: Date, select: false },
    apiKeyOtpPurpose: { type: String, select: false },
    apiKeyOtpAttempts: { type: Number, default: 0, select: false },
    apiKeyOtpKeyId: { type: String, select: false },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorCodeHash: { type: String, select: false },
    twoFactorCodeExpiresAt: { type: Date, select: false },
    profileOtpCodeHash: { type: String, select: false },
    profileOtpCodeExpiresAt: { type: Date, select: false },
    profileOtpPurpose: { type: String, select: false },
    pendingEmail: { type: String, trim: true, lowercase: true, select: false },
    pendingPhone: { type: String, trim: true, select: false },
    pendingName: { type: String, trim: true, select: false },
    loginOtpCodeHash: { type: String, select: false },
    loginOtpCodeExpiresAt: { type: Date, select: false },
    loginOtpAttempts: { type: Number, default: 0, select: false },
    loginOtpLastSentAt: { type: Date, select: false },
    registerOtpCodeHash: { type: String, select: false },
    registerOtpCodeExpiresAt: { type: Date, select: false },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetTokenExpiresAt: { type: Date, select: false },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);

module.exports = { User };
