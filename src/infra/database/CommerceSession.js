const { define, ref, secret } = require("@modules/commerce/models/schema");
const CommerceSession = define(
  "CommerceSession",
  {
    kind: { type: String, enum: ["oauth", "fulfillment"], required: true },
    tokenHash: { type: String, required: true, immutable: true, select: false },
    orderId: ref("CommerceOrder", false),
    userId: { type: String, default: "" },
    environment: { type: String, enum: ["test", "live"], default: "test" },
    dataEnc: secret(),
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  [
    [
      {
        tokenHash: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        expiresAt: 1,
      },
      {
        expireAfterSeconds: 0,
      },
    ],
  ],
);
module.exports = { CommerceSession };
