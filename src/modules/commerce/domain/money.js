const MAX_MONEY = 100_000_000_000;
function integer(value, name, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${name} must be a non-negative safe integer at most ${max}`);
  return value;
}
function parseRupees(value) {
  if (typeof value !== "string" || value.length > 13 || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new RangeError("Price requires a decimal string with at most two decimal places");
  const [whole, fraction = ""] = value.split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(MAX_MONEY)) throw new RangeError("Price exceeds supported amount");
  return Number(paise);
}
function includedTax(grossPaise, taxRateBps) {
  integer(grossPaise, "Amount");
  if (taxRateBps == null) return null;
  integer(taxRateBps, "Tax rate", 10000);
  const divisor = 10000n + BigInt(taxRateBps);
  return Number((BigInt(grossPaise) * BigInt(taxRateBps) + divisor / 2n) / divisor);
}
function calculateQuote(items, deliveryPaise = 0, deliveryTaxRateBps = null) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new RangeError("An order requires 1 to 100 items");
  integer(deliveryPaise, "Delivery charge");
  if (deliveryTaxRateBps != null) integer(deliveryTaxRateBps, "Delivery tax rate", 10000);
  const deliveryIncludedTaxPaise = deliveryPaise === 0 ? 0 : includedTax(deliveryPaise, deliveryTaxRateBps);
  let subtotal = 0n, tax = 0n, taxComplete = true;
  const seen = new Set();
  const lines = Array.from(items, (item) => {
    if (!item || typeof item.sku !== "string" || !item.sku.trim() || item.sku.length > 100 || seen.has(item.sku)) throw new RangeError("Order SKUs must be unique and nonempty strings of at most 100 characters");
    seen.add(item.sku);
    integer(item.unitPricePaise, "Unit price");
    integer(item.quantity, "Quantity", 10000);
    if (!item.quantity) throw new RangeError("Quantity must be positive");
    const gross = BigInt(item.unitPricePaise) * BigInt(item.quantity);
    if (gross > BigInt(MAX_MONEY)) throw new RangeError("Line total exceeds supported amount");
    const taxPaise = includedTax(Number(gross), item.taxRateBps);
    if (taxPaise == null) taxComplete = false;
    else tax += BigInt(taxPaise);
    subtotal += gross;
    return { ...item, grossPaise: Number(gross), includedTaxPaise: taxPaise };
  });
  const total = subtotal + BigInt(deliveryPaise);
  if (deliveryIncludedTaxPaise == null) taxComplete = false;
  else tax += BigInt(deliveryIncludedTaxPaise);
  if (total > BigInt(MAX_MONEY)) throw new RangeError("Order exceeds supported amount");
  return { currency: "INR", items: lines, subtotalPaise: Number(subtotal), deliveryPaise, deliveryTaxRateBps, deliveryIncludedTaxPaise, totalPaise: Number(total), includedTaxPaise: taxComplete ? Number(tax) : null };
}
module.exports = { MAX_MONEY, integer, parseRupees, includedTax, calculateQuote };
