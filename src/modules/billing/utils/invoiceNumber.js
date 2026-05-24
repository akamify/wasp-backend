function buildFinancialYear(date = new Date()) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

function formatInvoiceNumber({ prefix = "INV", financialYear, sequence }) {
  const seq = String(sequence || 0).padStart(5, "0");
  return `${prefix}/${financialYear}/${seq}`;
}

module.exports = { buildFinancialYear, formatInvoiceNumber };

