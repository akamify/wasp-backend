const mongoose = require("mongoose");

const InvoiceCounterSchema = new mongoose.Schema(
  {
    financialYear: { type: String, required: true, index: true },
    prefix: { type: String, required: true, default: "INV", trim: true },
    nextSequence: { type: Number, required: true, min: 1, default: 1 },
  },
  { timestamps: true }
);

InvoiceCounterSchema.index({ financialYear: 1, prefix: 1 }, { unique: true });

const InvoiceCounter = mongoose.model("InvoiceCounter", InvoiceCounterSchema);

module.exports = { InvoiceCounter };

