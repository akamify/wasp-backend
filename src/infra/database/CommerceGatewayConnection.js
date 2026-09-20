const { define, count, secret } = require("@modules/commerce/models/schema");
const CommerceGatewayConnection = define(
  "CommerceGatewayConnection",
  {
    provider: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
      immutable: true,
    },
    environment: {
      type: String,
      enum: ["test", "live"],
      required: true,
      immutable: true,
    },
    authType: { type: String, enum: ["api_keys", "oauth"], required: true },
    keyIdEnc: secret(),
    keySecretEnc: secret(),
    accessTokenEnc: secret(),
    refreshTokenEnc: secret(),
    keyFingerprint: { type: String, select: false, default: undefined },
    keyLabel: { type: String, default: "" },
    merchantAccountId: { type: String, default: undefined },
    identityVerified: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["connected", "error", "disconnected", "revoked"],
      default: "connected",
    },
    active: { type: Boolean, default: true },
    credentialsVerifiedAt: { type: Date, default: null },
    tokenExpiresAt: { type: Date, default: null },
    refreshAfter: { type: Date, default: null },
    refreshLeaseUntil: { type: Date, default: null },
    refreshLeaseOwner: { type: String, default: "", select: false },
    refreshState: {
      type: String,
      enum: ["idle", "refreshing", "unknown"],
      default: "idle",
    },
    oauthClientId: { type: String, default: "", immutable: true },
    oauthAuthorizedAt: { type: Date, default: null, immutable: true },
    lastErrorCode: { type: String, default: "" },
    webhookSecretEnc: secret(),
    previousWebhookSecretEnc: secret(),
    previousWebhookSecretExpiresAt: { type: Date, default: null },
    webhookStatus: {
      type: String,
      enum: ["needs_setup", "verified", "error"],
      default: "needs_setup",
    },
    lastWebhookAt: { type: Date, default: null },
    nativePaymentStatus: {
      type: String,
      enum: [
        "unverified",
        "setup_required",
        "pending",
        "not_eligible",
        "eligible",
        "active",
        "error",
      ],
      default: "unverified",
    },
    nativeConfigurationName: { type: String, default: "" },
    createdBy: { type: String, required: true },
    revision: count(1),
  },
  [
    [
      {
        provider: 1,
        environment: 1,
        merchantAccountId: 1,
        oauthClientId: 1,
        oauthAuthorizedAt: 1,
      },
      {},
    ],
    [{ active: 1, authType: 1, refreshState: 1, refreshAfter: 1 }, {}],
    [{ active: 1, authType: 1, refreshState: 1, refreshLeaseUntil: 1 }, {}],
    [
      {
        workspaceId: 1,
        provider: 1,
        environment: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          active: true,
        },
      },
    ],
    [
      {
        keyFingerprint: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          keyFingerprint: {
            $type: "string",
          },
          active: true,
        },
      },
    ],
    [
      {
        provider: 1,
        environment: 1,
        merchantAccountId: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          merchantAccountId: {
            $type: "string",
          },
          active: true,
          identityVerified: true,
        },
      },
    ],
  ],
);
module.exports = { CommerceGatewayConnection };
