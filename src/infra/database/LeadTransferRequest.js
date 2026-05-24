const mongoose = require("mongoose");

const LeadTransferRequestSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    phone: { type: String, required: true, index: true },
    fromEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    requestedByEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED"], default: "PENDING", index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, trim: true, default: "" },
    overrideReason: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

LeadTransferRequestSchema.index({ workspaceId: 1, conversationId: 1, status: 1, createdAt: -1 });

const LeadTransferRequest = mongoose.model("LeadTransferRequest", LeadTransferRequestSchema);

module.exports = { LeadTransferRequest };

