const mongoose = require("mongoose");

const linkSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  status: { type: String, enum: ["pending", "active", "rejected", "revoked"], required: true },
  requestedAt: { type: Date, required: true },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { _id: false, strict: "throw" });

// One reporting group per user. The built-in _id index enforces ownership uniqueness.
const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  revision: { type: Number, default: 1 },
  links: { type: [linkSchema], default: [], validate: (v) => v.length <= 100 },
}, { timestamps: true, strict: "throw", autoIndex: false, autoCreate: false });
schema.index({ "links.workspaceId": 1 }, { name: "group_workspace_inbox" });
const BusinessGroup = mongoose.models.BusinessGroup || mongoose.model("BusinessGroup", schema);
module.exports = { BusinessGroup };
