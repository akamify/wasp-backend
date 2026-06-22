const mongoose = require("mongoose");

const DocFeedbackSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, trim: true, index: true },
    docTitle: { type: String, default: "", trim: true },
    helpful: { type: Boolean, required: true },
    pagePath: { type: String, default: "", trim: true },
    visitorId: { type: String, default: "", trim: true },
    ipAddress: { type: String, default: "", trim: true },
    userAgent: { type: String, default: "", trim: true },
    source: { type: String, default: "docs-web", trim: true },
  },
  { timestamps: true, versionKey: false }
);

DocFeedbackSchema.index({ slug: 1, createdAt: -1 });
DocFeedbackSchema.index({ visitorId: 1, slug: 1, createdAt: -1 });

const DocFeedback = mongoose.models.DocFeedback || mongoose.model("DocFeedback", DocFeedbackSchema);

module.exports = { DocFeedback };
