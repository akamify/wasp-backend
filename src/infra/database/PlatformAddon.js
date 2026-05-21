const mongoose = require("mongoose");

const PlatformAddonSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    category: { type: String, required: true, trim: true, index: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    enabled: { type: Boolean, default: false },
    visibleInFrontend: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    editableBy: { type: String, enum: ["super_admin"], default: "super_admin" },
    metadata: { type: Object, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

PlatformAddonSchema.index({ category: 1, sortOrder: 1 });

const PlatformAddon = mongoose.model("PlatformAddon", PlatformAddonSchema);

module.exports = { PlatformAddon };
