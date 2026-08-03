const mongoose = require("mongoose");

const GeminiModelSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 120 },
    label: { type: String, trim: true, maxlength: 160, default: "" },
    deprecated: { type: Boolean, default: false },
    sortOrder: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const AiProviderConfigSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["gemini"],
      required: true,
      unique: true,
      index: true,
      default: "gemini",
    },
    defaultModel: { type: String, trim: true, maxlength: 120, required: true },
    models: {
      type: [GeminiModelSchema],
      default: [],
    },
    manualModeEnabled: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

const AiProviderConfig = mongoose.model("AiProviderConfig", AiProviderConfigSchema);

module.exports = { AiProviderConfig };
