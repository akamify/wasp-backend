const mongoose = require("mongoose");

const WhatsAppCredentialsSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
    },

    // Encrypted values (AES-256-GCM). Kept out of normal query projections.
    accessTokenEnc: { type: String, required: true, select: false },
    phoneNumberIdEnc: { type: String, required: true, select: false },
    businessAccountIdEnc: { type: String, required: true, select: false },

    // Deterministic lookup for multi-tenant webhook routing.
    phoneNumberIdHash: { type: String, required: true, index: true },
    businessAccountIdHash: { type: String, required: true, index: true },

    graphApiVersion: { type: String, default: "v22.0" },
    isValid: { type: Boolean, default: false },
    lastValidatedAt: { type: Date },

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
  },
  { timestamps: true }
);

const WhatsAppCredentials = mongoose.model(
  "WhatsAppCredentials",
  WhatsAppCredentialsSchema
);

module.exports = { WhatsAppCredentials };

