const mongoose = require("mongoose");

const LiveDemoEnquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 220 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    platform: { type: String, enum: ["Google Meet", "Zoom"], required: true },
    date: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    slot: { type: String, required: true, trim: true },
    notes: { type: String, required: true, trim: true, minlength: 20, maxlength: 2000 },
    status: {
      type: String,
      enum: ["Pending", "Confirmed", "Completed", "Cancelled"],
      default: "Pending",
      index: true,
    },
  },
  { timestamps: true }
);

LiveDemoEnquirySchema.index({ date: 1, slot: 1 }, { unique: true });
LiveDemoEnquirySchema.index({ createdAt: -1 });
LiveDemoEnquirySchema.index({ email: 1 });
LiveDemoEnquirySchema.index({ phone: 1 });

const LiveDemoEnquiry = mongoose.model("LiveDemoEnquiry", LiveDemoEnquirySchema);

module.exports = { LiveDemoEnquiry };
