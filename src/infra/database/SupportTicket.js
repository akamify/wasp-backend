const mongoose = require("mongoose");

const SupportTicketSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    phone: { type: String, default: "", trim: true },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: ["open", "resolved"], default: "open", index: true },
    resolvedAt: { type: Date, default: null },
    resolvedByAdminId: { type: String, default: "" },
    resolutionNote: { type: String, default: "" },
  },
  { timestamps: true }
);

SupportTicketSchema.index({ createdAt: -1 });

const SupportTicket = mongoose.model("SupportTicket", SupportTicketSchema);

module.exports = { SupportTicket };

