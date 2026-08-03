const mongoose = require("mongoose");

const TemplateLibraryEventSchema = new mongoose.Schema(
  {
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true, index: true },
    sourceTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null, index: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    eventType: {
      type: String,
      enum: ["preview", "use", "copy", "download", "favorite", "unfavorite"],
      required: true,
      index: true,
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

TemplateLibraryEventSchema.index({ templateId: 1, eventType: 1, createdAt: -1 });
TemplateLibraryEventSchema.index({ workspaceId: 1, eventType: 1, createdAt: -1 });
TemplateLibraryEventSchema.index({ sourceTemplateId: 1, eventType: 1, createdAt: -1 });

const TemplateLibraryEvent = mongoose.model("TemplateLibraryEvent", TemplateLibraryEventSchema);

module.exports = { TemplateLibraryEvent };
