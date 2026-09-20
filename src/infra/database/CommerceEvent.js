const {
  define,
  ref,
  count,
  secret,
} = require("@modules/commerce/models/schema");
const CommerceEvent = define(
  "CommerceEvent",
  {
    gatewayConnectionId: ref("CommerceGatewayConnection", false),
    kind: {
      type: String,
      enum: ["whatsapp.order", "razorpay"],
      required: true,
      immutable: true,
    },
    eventKey: { type: String, required: true, immutable: true },
    payloadEnc: secret(),
    status: {
      type: String,
      enum: ["pending", "processing", "processed", "dead_letter"],
      default: "pending",
    },
    attempts: count(),
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: null },
    leaseOwner: { type: String, default: "" },
    lastError: { type: String, default: "", maxlength: 300 },
    processedAt: { type: Date, default: null },
  },
  [
    [{ kind: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 }, {}],
    [{ workspaceId: 1, kind: 1, status: 1, _id: -1 }, {}],
    [
      {
        workspaceId: 1,
        eventKey: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        status: 1,
        nextAttemptAt: 1,
        leaseUntil: 1,
      },
    ],
  ],
);
module.exports = { CommerceEvent };
