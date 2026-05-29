const mongoose = require("mongoose");

const DocSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedByAdminId: { type: String, default: "" },
  },
  { timestamps: true, collection: "docssettings" }
);

const DocSetting = mongoose.models.DocSetting || mongoose.model("DocSetting", DocSettingSchema);

module.exports = { DocSetting };

