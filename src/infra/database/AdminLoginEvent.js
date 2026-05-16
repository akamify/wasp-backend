const mongoose = require("mongoose");

const AdminLoginEventSchema = new mongoose.Schema(
  {
    adminAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "AdminAccount", required: true, index: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    method: { type: String, default: "password" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AdminLoginEventSchema.index({ adminAccountId: 1, createdAt: -1 });

const AdminLoginEvent = mongoose.model("AdminLoginEvent", AdminLoginEventSchema);

module.exports = { AdminLoginEvent };

