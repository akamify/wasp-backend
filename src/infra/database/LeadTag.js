const mongoose = require("mongoose");

const LeadTagSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    color: { type: String, trim: true, default: "" },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

LeadTagSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

const LeadTag = mongoose.model("LeadTag", LeadTagSchema);

module.exports = { LeadTag };

