const mongoose = require("mongoose");

const AiTopupPackSchema = new mongoose.Schema(
  {
    packId: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    status: {
      type: String,
      enum: ["draft", "published", "archived", "disabled"],
      default: "draft",
      index: true,
    },
    currency: { type: String, trim: true, default: "INR", maxlength: 8 },
    credits: { type: Number, min: 1, required: true },
    price: { type: Number, min: 0, required: true },
    sortOrder: { type: Number, min: 0, default: 0 },
    featured: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

AiTopupPackSchema.index({ status: 1, sortOrder: 1, createdAt: -1 });

const AiTopupPack = mongoose.model("AiTopupPack", AiTopupPackSchema);

module.exports = { AiTopupPack };
