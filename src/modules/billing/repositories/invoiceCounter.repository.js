const { InvoiceCounter } = require("@infra/database/InvoiceCounter");

async function nextSequence({ financialYear, prefix }) {
  const row = await InvoiceCounter.findOneAndUpdate(
    { financialYear, prefix },
    { $setOnInsert: { financialYear, prefix, nextSequence: 1 }, $inc: { nextSequence: 1 } },
    { upsert: true, new: true }
  );
  return Math.max(1, Number(row.nextSequence || 1) - 1);
}

module.exports = { nextSequence };

