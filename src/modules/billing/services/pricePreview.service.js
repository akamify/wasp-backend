const { calculatePrice } = require("@modules/billing/utils/priceCalculator");

function rupeesToPaise(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function buildPricePreview({ originalPricePaise, discountedPricePaise, gstPercent, taxMode }) {
  return calculatePrice({
    originalPricePaise,
    discountedPricePaise,
    gstPercent,
    taxMode,
  });
}

module.exports = { rupeesToPaise, buildPricePreview };
