const mongoose = require("mongoose");

const ContactAttributeDefinitionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    key: { type: String, required: true, lowercase: true, trim: true, maxlength: 50 },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    type: {
      type: String,
      enum: ["text", "number", "boolean", "date", "url"],
      default: "text",
    },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    defaultValue: { type: mongoose.Schema.Types.Mixed },
    required: { type: Boolean, default: false },
    visible: { type: Boolean, default: true },
    editable: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    system: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ContactAttributeDefinitionSchema.index({ workspaceId: 1, key: 1 }, { unique: true });

const ContactAttributeDefinition = mongoose.model(
  "ContactAttributeDefinition",
  ContactAttributeDefinitionSchema
);

module.exports = { ContactAttributeDefinition };
