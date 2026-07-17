const mongoose = require("mongoose");

const KnowledgeChunkSchema = new mongoose.Schema(
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
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeSource",
      required: true,
      index: true,
    },
    chunkText: { type: String, trim: true, maxlength: 2000, required: true },
    contentHash: { type: String, trim: true, maxlength: 128, default: "", index: true },
    chunkIndex: { type: Number, min: 0, required: true },
    metadata: {
      sourceTitle: { type: String, trim: true, maxlength: 200, default: "" },
      sourceType: { type: String, trim: true, maxlength: 32, default: "" },
      sourceUrl: { type: String, trim: true, maxlength: 2048, default: "" },
    },
    embedding: { type: [Number], default: [] },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

KnowledgeChunkSchema.index({ workspaceId: 1, agentId: 1, sourceId: 1, chunkIndex: 1 }, { unique: true });
KnowledgeChunkSchema.index({ workspaceId: 1, agentId: 1, deletedAt: 1, updatedAt: -1 });

const KnowledgeChunk = mongoose.model("KnowledgeChunk", KnowledgeChunkSchema);

module.exports = { KnowledgeChunk };
