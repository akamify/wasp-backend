const mongoose = require("mongoose");

const ContactSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    phone: { type: String, required: true, index: true },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    company: { type: String, trim: true },
    language: { type: String, trim: true, default: null },
    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true }],
    source: {
      type: String,
      enum: ["manual", "inbound", "outbound", "imported"],
      default: "manual",
    },
    lastMessagePreview: { type: String },
    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },
  },
  { timestamps: true }
);

ContactSchema.index({ workspaceId: 1, phone: 1 }, { unique: true });

const Contact = mongoose.model("Contact", ContactSchema);

module.exports = { Contact };
