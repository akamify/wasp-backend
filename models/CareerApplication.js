const mongoose = require("mongoose");

const CareerApplicationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    resume: {
      originalName: { type: String, required: true },
      // Legacy local storage (uploads/resumes). Kept for backward compatibility.
      storedName: { type: String, default: "" },
      // Cloudinary fields (preferred)
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
      mimeType: { type: String, required: true },
      sizeBytes: { type: Number, required: true },
    },
    whatsappPhone: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    organisationName: { type: String, required: true, trim: true },
    currentRole: { type: String, required: true, trim: true },
    applyingRole: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    yearsExpIndustry: { type: Number, required: true },
    yearsCurrentJob: { type: Number, required: true },
    currentSalary: { type: String, required: true, trim: true },
    expectedSalary: { type: String, required: true, trim: true },
    noticePeriod: { type: String, required: true, trim: true },
    modeOfWork: { type: String, required: true, trim: true },
    status: { type: String, enum: ["new", "reviewing", "shortlisted", "rejected"], default: "new", index: true },
    adminNote: { type: String, default: "" },
    updatedByAdminId: { type: String, default: "" },
  },
  { timestamps: true }
);

CareerApplicationSchema.index({ createdAt: -1 });

const CareerApplication = mongoose.model("CareerApplication", CareerApplicationSchema);

module.exports = { CareerApplication };
