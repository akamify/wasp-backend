const {
  define,
  mongoose,
  ref,
  count,
} = require("@modules/commerce/models/schema");
const CommerceInventoryReservation = define(
  "CommerceInventoryReservation",
  {
    orderId: ref("CommerceOrder"),
    attemptId: ref("CommerceCheckoutAttempt"),
    items: {
      type: [
        new mongoose.Schema(
          {
            productId: ref("CommerceProduct"),
            outletId: { type: mongoose.Schema.Types.ObjectId, default: null },
            quantity: { ...count(1), min: 1, max: 10000 },
          },
          { _id: false, strict: "throw" },
        ),
      ],
      default: [],
      validate: (v) => v.length <= 100 && new Set(v.map((item) => String(item.productId))).size === v.length,
    },
    status: {
      type: String,
      enum: ["held", "consumed", "released"],
      default: "held",
    },
    expiresAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
  },
  [
    [
      {
        attemptId: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        status: 1,
        expiresAt: 1,
      },
    ],
  ],
);
module.exports = { CommerceInventoryReservation };
