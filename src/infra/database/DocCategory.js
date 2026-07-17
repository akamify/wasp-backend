const mongoose = require("mongoose");

const DocCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    order: { type: Number, default: 0, index: true },
    icon: { type: String, default: "BookOpen", trim: true },
    description: { type: String, default: "", trim: true },
    audience: { type: [String], default: [] },
    isPublished: { type: Boolean, default: true, index: true },
    updatedByAdminId: { type: String, default: "" },
  },
  { timestamps: true, collection: "doccategories" }
);

DocCategorySchema.index({ isPublished: 1, order: 1, name: 1 });

const DocCategory = mongoose.models.DocCategory || mongoose.model("DocCategory", DocCategorySchema);

module.exports = { DocCategory };
