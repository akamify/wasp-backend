const mongoose = require("mongoose");
const { AudienceGroupSchema } = require("@infra/database/Audience");

const SavedFilterSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    wabaId: { type: String, trim: true, required: true, index: true },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    description: { type: String, trim: true, default: "", maxlength: 500 },
    filterTree: { type: AudienceGroupSchema, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

SavedFilterSchema.index({ workspaceId: 1, wabaId: 1, createdAt: -1 });
SavedFilterSchema.index({ workspaceId: 1, wabaId: 1, name: 1 }, { unique: true });

const SavedFilter = mongoose.model("SavedFilter", SavedFilterSchema);

module.exports = { SavedFilter };
