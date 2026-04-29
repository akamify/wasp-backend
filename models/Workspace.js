const mongoose = require("mongoose");

const WorkspaceSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    plan: { type: String, default: "free" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

WorkspaceSchema.index({ ownerId: 1, name: 1 });

const Workspace = mongoose.model("Workspace", WorkspaceSchema);

module.exports = { Workspace };

