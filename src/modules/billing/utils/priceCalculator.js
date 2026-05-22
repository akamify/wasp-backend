const { TAX_MODES } = require("@modules/billing/constants/taxModes");

function toPaise(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function calculatePrice({
  originalPricePaise,
  discountedPricePaise,
  gstPercent,
  taxMode = TAX_MODES.EXCLUSIVE,
}) {
  const original = toPaise(originalPricePaise);
  const discounted = toPaise(discountedPricePaise);
  const safeDiscounted = Math.min(discounted, original || discounted);
  const safeOriginal = Math.max(original, safeDiscounted);
  const gst = clampPercent(gstPercent);

  const discountAmountPaise = Math.max(0, safeOriginal - safeDiscounted);
  const discountPercent = safeOriginal > 0 ? Math.round((discountAmountPaise / safeOriginal) * 100) : 0;

  let gstAmountPaise = 0;
  let payableAmountPaise = safeDiscounted;
  if (taxMode === TAX_MODES.INCLUSIVE) {
    gstAmountPaise = gst > 0 ? Math.round((safeDiscounted * gst) / (100 + gst)) : 0;
    payableAmountPaise = safeDiscounted;
  } else {
    gstAmountPaise = Math.round((safeDiscounted * gst) / 100);
    payableAmountPaise = safeDiscounted + gstAmountPaise;
  }

  return {
    originalPricePaise: safeOriginal,
    discountedPricePaise: safeDiscounted,
    discountAmountPaise,
    discountPercent,
    gstPercent: gst,
    gstAmountPaise,
    payableAmountPaise,
    taxMode,
  };
}

module.exports = { calculatePrice };

