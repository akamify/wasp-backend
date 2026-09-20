const {
  define,
  ref,
  amount,
  count,
} = require("@modules/commerce/models/schema");
const CommerceCheckoutAttempt = define(
  "CommerceCheckoutAttempt",
  {
    orderId: ref("CommerceOrder"),
    gatewayConnectionId: ref("CommerceGatewayConnection"),
    orderRevision: { ...count(1), immutable: true },
    environment: {
      type: String,
      enum: ["test", "live"],
      required: true,
      immutable: true,
    },
    mode: {
      type: String,
      enum: ["razorpay_payment_link", "whatsapp_native"],
      required: true,
      immutable: true,
    },
    reference: { type: String, required: true, immutable: true, maxlength: 35 },
    idempotencyKey: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 100,
    },
    requestHash: { type: String, required: true, immutable: true },
    amountPaise: { ...amount(), immutable: true },
    currency: { type: String, enum: ["INR"], default: "INR", immutable: true },
    status: {
      type: String,
      enum: require("@modules/commerce/domain/states").ATTEMPT_STATES,
      default: "creating",
    },
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, required: true, immutable: true },
    providerLinkId: { type: String, default: undefined },
    providerOrderId: { type: String, default: undefined },
    nativeConfigurationName: { type: String, maxlength: 60, immutable: true },
    nativeWabaId: { type: String, immutable: true },
    nativePhoneNumberId: { type: String, immutable: true },
    nativeMerchantAccountId: { type: String, immutable: true },
    nativeCancelStartedAt: { type: Date, default: null },
    paymentUrl: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    nextCheckAt: { type: Date, default: Date.now },
    reconcileCount: count(),
    captureCursor: count(),
    lastError: { type: String, default: "", maxlength: 300 },
    revision: count(1),
    createStartedAt: { type: Date, default: null },
    cancelRequestedAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    leaseOwner: { type: String, default: "", select: false },
    requestedBy: { type: String, default: "", immutable: true },
  },
  [
    [{ nextCheckAt: 1, leaseUntil: 1 }],
    [{ workspaceId: 1, orderId: 1, _id: -1 }],
    [
      {
        workspaceId: 1,
        idempotencyKey: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        reference: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        orderId: 1,
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
        gatewayConnectionId: 1,
        providerLinkId: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          providerLinkId: {
            $type: "string",
          },
        },
      },
    ],
    [
      {
        active: 1,
        nextCheckAt: 1,
      },
    ],
  ],
);
module.exports = { CommerceCheckoutAttempt };
