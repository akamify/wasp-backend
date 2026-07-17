const mongoose = require("mongoose");

const KnowledgeSourceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiAgent",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["faq", "text", "url", "pdf", "docx", "csv", "txt"],
      required: true,
      index: true,
    },
    title: { type: String, trim: true, maxlength: 200, required: true },
    content: { type: String, trim: true, maxlength: 50000, default: "" },
    sourceUrl: { type: String, trim: true, maxlength: 2048, default: "" },
    contentHash: { type: String, trim: true, maxlength: 128, default: "", index: true },
    status: {
      type: String,
      enum: ["draft", "indexing", "indexed", "failed"],
      default: "draft",
      index: true,
    },
    metadata: {
      totalChunks: { type: Number, min: 0, default: 0 },
      lastIndexedAt: { type: Date, default: null },
      error: { type: String, trim: true, maxlength: 1000, default: "" },
      question: { type: String, trim: true, maxlength: 5000, default: "" },
      answer: { type: String, trim: true, maxlength: 30000, default: "" },
      originalName: { type: String, trim: true, maxlength: 255, default: "" },
      mimeType: { type: String, trim: true, maxlength: 120, default: "" },
      sizeBytes: { type: Number, min: 0, default: 0 },
      extractionMethod: { type: String, trim: true, maxlength: 80, default: "" },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

KnowledgeSourceSchema.index({ workspaceId: 1, agentId: 1, deletedAt: 1, updatedAt: -1 });
KnowledgeSourceSchema.index(
  { workspaceId: 1, agentId: 1, contentHash: 1, deletedAt: 1 },
  { unique: true, partialFilterExpression: { contentHash: { $gt: "" } } },
);

const KnowledgeSource = mongoose.model("KnowledgeSource", KnowledgeSourceSchema);

module.exports = { KnowledgeSource };
