const { define, ref, secret } = require("@modules/commerce/models/schema");
const CommerceOutbox = define(
  "CommerceOutbox",
  {
    orderId: ref("CommerceOrder"),
    key: { type: String, required: true, immutable: true },
    payloadEnc: secret(),
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "unknown", "blocked"],
      default: "pending",
    },
    whatsappMessageId: { type: String, default: "" },
    lastError: { type: String, default: "", maxlength: 300 },
    startedAt: { type: Date, default: null },
    requestedBy: { type: String, default: "", immutable: true },
  },
  [
    [{ workspaceId: 1, orderId: 1, _id: -1 }],
    [
      {
        workspaceId: 1,
        key: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        status: 1,
        createdAt: 1,
      },
    ],
  ],
);
module.exports = { CommerceOutbox };
