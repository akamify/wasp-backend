const { define, count } = require("@modules/commerce/models/schema");
const CommerceSettings = define(
  "CommerceSettings",
  {
    enabled: { type: Boolean, default: false },
    liveCheckoutEnabled: { type: Boolean, default: false },
    currency: { type: String, enum: ["INR"], default: "INR", immutable: true },
    pickupEnabled: { type: Boolean, default: true },
    deliveryEnabled: { type: Boolean, default: false },
    pickupInstructions: { type: String, maxlength: 1000, default: "" },
    reservationMinutes: {
      type: Number,
      min: 5,
      max: 120,
      validate: Number.isInteger,
      default: 30,
    },
    testRecipients: { type: [String], default: [] },
    revision: count(1),
  },
  [
    [
      {
        workspaceId: 1,
      },
      {
        unique: true,
      },
    ],
  ],
);
module.exports = { CommerceSettings };
