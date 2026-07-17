const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    action: { type: String, required: true, trim: true, index: true },
    resourceType: { type: String, trim: true, default: "" },
    resourceId: { type: String, trim: true, default: "" },
    dedupeKey: { type: String, trim: true, default: undefined, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

AuditLogSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

const AuditLog = mongoose.model("AuditLog", AuditLogSchema);

module.exports = { AuditLog };
