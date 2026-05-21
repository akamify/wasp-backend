const mongoose = require("mongoose");

const PlatformSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    category: { type: String, required: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    valueType: {
      type: String,
      enum: ["string", "number", "boolean", "json", "secret"],
      required: true,
      default: "string",
    },
    encrypted: { type: Boolean, default: false },
    masked: { type: Boolean, default: false },
    description: { type: String, default: "" },
    editableBy: { type: String, enum: ["super_admin"], default: "super_admin" },
    enabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

PlatformSettingSchema.index({ key: 1 }, { unique: true });
PlatformSettingSchema.index({ category: 1 });

const PlatformSetting = mongoose.model("PlatformSetting", PlatformSettingSchema);

module.exports = { PlatformSetting };
