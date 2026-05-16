const mongoose = require("mongoose");

const PublicPageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    // Flexible JSON payload managed from admin UI.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedByAdminId: { type: String, default: "" },
  },
  { timestamps: true }
);

const PublicPage = mongoose.model("PublicPage", PublicPageSchema);

module.exports = { PublicPage };

