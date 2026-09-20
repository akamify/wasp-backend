const { define, ref, amount } = require("@modules/commerce/models/schema");
const CommercePayment = define(
  "CommercePayment",
  {
    orderId: ref("CommerceOrder"),
    attemptId: ref("CommerceCheckoutAttempt"),
    gatewayConnectionId: ref("CommerceGatewayConnection"),
    environment: {
      type: String,
      enum: ["test", "live"],
      required: true,
      immutable: true,
    },
    providerPaymentId: { type: String, required: true, immutable: true },
    providerOrderId: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "authorized", "captured", "failed"],
      required: true,
    },
    amountPaise: amount(),
    currency: { type: String, enum: ["INR"], default: "INR" },
    method: { type: String, default: "" },
    capturedAt: { type: Date, default: null },
    verifiedAt: { type: Date, required: true },
    refundedPaise: amount(),
    overpayment: { type: Boolean, default: false },
    nextCheckAt: { type: Date, default: Date.now },
    refundCursor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    lastError: { type: String, default: "", maxlength: 300 },
  },
  [
    [{ nextCheckAt: 1 }],
    [
      {
        gatewayConnectionId: 1,
        providerPaymentId: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        workspaceId: 1,
        environment: 1,
        _id: -1,
      },
    ],
  ],
);
module.exports = { CommercePayment };
