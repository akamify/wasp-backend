const mongoose = require("mongoose");

const WhatsAppCredentialsSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    // Encrypted values (AES-256-GCM). Kept out of normal query projections.
    accessTokenEnc: { type: String, required: true, select: false },
    phoneNumberIdEnc: { type: String, required: true, select: false },
    businessAccountIdEnc: { type: String, required: true, select: false },

    // Deterministic lookup for multi-tenant webhook routing.
    phoneNumberIdHash: { type: String, required: true, index: true },
    businessAccountIdHash: { type: String, required: true, index: true },
    // Plain IDs are not secrets; keep them indexed for stable webhook routing across env hash/key changes.
    phoneNumberIdPlain: { type: String, default: null, index: true },
    businessAccountIdPlain: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    wabaId: { type: String, default: null, index: true },

    graphApiVersion: { type: String, default: "v22.0" },
    connectionMode: { type: String, default: null, index: true },
    tokenType: { type: String, default: null, index: true },
    tokenDebugSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    isValid: { type: Boolean, default: false },
    lastValidatedAt: { type: Date },
    displayPhoneNumber: { type: String, default: null },
    wabaName: { type: String, default: null },
    wabaCurrency: { type: String, default: null },
    wabaTimezoneId: { type: String, default: null },
    messageTemplateNamespace: { type: String, default: null },
    verifiedName: { type: String, default: null },
    nameStatus: { type: String, default: null },
    qualityRating: { type: String, default: null },
    codeVerificationStatus: { type: String, default: null },
    platformType: { type: String, default: null },
    accountMode: { type: String, default: null },
    throughput: { type: mongoose.Schema.Types.Mixed, default: null },
    messagingLimitTier: { type: String, default: null },
    businessProfile: {
      about: { type: String, default: null },
      address: { type: String, default: null },
      description: { type: String, default: null },
      email: { type: String, default: null },
      profilePictureUrl: { type: String, default: null },
      websites: { type: [String], default: [] },
      vertical: { type: String, default: null },
    },
    lastMetadataSyncAt: { type: Date, default: null },
    metadataFetchStatus: {
      type: String,
      enum: ["pending", "complete", "partial", "error"],
      default: "pending",
      index: true,
    },
    metadataWarnings: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    businessTokenEnc: { type: String, default: null, select: false },
    connectionMethod: { type: String, enum: ["embedded_signup"], default: "embedded_signup", index: true },
    webhookSubscribed: { type: Boolean, default: false, index: true },
    status: {
      type: String,
      enum: ["pending", "active", "failed", "disconnected"],
      default: "pending",
      index: true,
    },
    lastError: { type: String, default: null },
    connectedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },

    // Connection governance (workspace can have only one connection; edits are audited)
    lastEditedAt: { type: Date, default: null },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastEditedReason: { type: String, default: null },

    // Best-effort cached signals from webhooks (some limits are not queryable via REST reliably)
    messagingLimitTierCached: { type: String, default: null },
    // Numeric "business-initiated conversations in a rolling 24-hour period" (WhatsApp Manager)
    messagingLimitCurrentCached: { type: Number, default: null },
    messagingLimitNextCached: { type: Number, default: null },
    lastLimitsUpdateAt: { type: Date, default: null },

    // Webhook telemetry (helps detect misconfigured callback URLs / signature failures).
    lastWebhookAt: { type: Date, default: null, index: true },
    lastWebhookField: { type: String, default: null },
    lastWebhookObject: { type: String, default: null },
  },
  { timestamps: true }
);

WhatsAppCredentialsSchema.index(
  { workspaceId: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

const WhatsAppCredentials = mongoose.model(
  "WhatsAppCredentials",
  WhatsAppCredentialsSchema
);

module.exports = { WhatsAppCredentials };

