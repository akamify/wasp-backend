const mongoose = require("mongoose");

const DocPageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    pageKey: { type: String, trim: true, lowercase: true, default: "", index: true },
    targetSectionId: { type: String, trim: true, lowercase: true, default: "" },
    title: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedByAdminId: { type: String, default: "" },
  },
  { timestamps: true, collection: "docs" }
);

const DocPage = mongoose.models.DocPage || mongoose.model("DocPage", DocPageSchema);

module.exports = { DocPage };
