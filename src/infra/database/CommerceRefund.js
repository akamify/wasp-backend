const { define, ref, amount } = require("@modules/commerce/models/schema");
const CommerceRefund = define(
  "CommerceRefund",
  {
    paymentId: ref("CommercePayment"),
    gatewayConnectionId: ref("CommerceGatewayConnection"),
    providerRefundId: { type: String, required: true, immutable: true },
    amountPaise: amount(),
    status: {
      type: String,
      enum: ["pending", "processed", "failed"],
      required: true,
    },
    verifiedAt: { type: Date, required: true },
  },
  [
    [{ workspaceId: 1, paymentId: 1, _id: -1 }],
    [
      {
        gatewayConnectionId: 1,
        providerRefundId: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        workspaceId: 1,
        paymentId: 1,
      },
    ],
  ],
);
module.exports = { CommerceRefund };
