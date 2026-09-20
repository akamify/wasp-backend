const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MAX_MONEY, parseRupees, includedTax, calculateQuote } = require("../domain/money");

test("decimal prices convert to integer paise without floating point rounding", () => {
  for (const [input, expected] of [["0", 0], ["0.01", 1], ["1.1", 110], ["19.99", 1999], ["1000000000.00", MAX_MONEY]]) {
    assert.equal(parseRupees(input), expected);
  }
});
test("ambiguous, fractional-paise, oversized and non-string prices are rejected", () => {
  for (const input of [1.1, null, undefined, {}, "", "-1", "+1", " 1", "1 ", "01", ".1", "1.", "1.001", "1e2", "1,000", "Infinity", "1000000000.01", "9".repeat(10000)]) {
    assert.throws(() => parseRupees(input), RangeError);
  }
});
test("inclusive tax rounds half up per line and preserves unconfirmed tax", () => {
  assert.equal(includedTax(11800, 1800), 1800);
  assert.equal(includedTax(1, 10000), 1);
  assert.equal(includedTax(999, 0), 0);
  assert.equal(includedTax(999, null), null);
  assert.equal(includedTax(MAX_MONEY, 10000), MAX_MONEY / 2);
  for (const rate of [-1, 10001, 0.5, NaN, Infinity]) assert.throws(() => includedTax(100, rate), RangeError);
});
test("quotes calculate trusted item totals and delivery without mutating inputs", () => {
  const input = Object.freeze([Object.freeze({ sku: "meal", unitPricePaise: 11800, quantity: 2, taxRateBps: 1800 })]);
  const quote = calculateQuote(input, 500, 0);
  assert.equal(quote.subtotalPaise, 23600);
  assert.equal(quote.totalPaise, 24100);
  assert.equal(quote.includedTaxPaise, 3600);
  assert.equal(quote.items[0].grossPaise, 23600);
  assert.equal(input[0].grossPaise, undefined);
  assert.equal(quote.currency, "INR");
});
test("unknown tax is never silently represented as zero", () => {
  const quote = calculateQuote([{ sku: "a", quantity: 1, unitPricePaise: 100, taxRateBps: null }]);
  assert.equal(quote.includedTaxPaise, null);
  const item = { sku: "a", quantity: 1, unitPricePaise: 11800, taxRateBps: 1800 };
  assert.equal(calculateQuote([item], 118).includedTaxPaise, null);
  assert.equal(calculateQuote([item], 118, 1800).includedTaxPaise, 1818);
});
test("quote input rejects invalid quantities, duplicate SKUs and oversized orders", () => {
  const item = { sku: "a", quantity: 1, unitPricePaise: 100, taxRateBps: 0 };
  for (const quantity of [0, -1, 1.5, 10001, NaN, "1", null]) {
    assert.throws(() => calculateQuote([{ ...item, quantity }]), RangeError);
  }
  for (const sku of ["", " ", 42, {}, "x".repeat(101)]) {
    assert.throws(() => calculateQuote([{ ...item, sku }]), RangeError);
  }
  for (const items of [null, [], [null], new Array(1), [item, item], Array.from({ length: 101 }, (_, i) => ({ ...item, sku: String(i) }))]) {
    assert.throws(() => calculateQuote(items), RangeError);
  }
  for (const price of [-1, 1.5, Infinity, MAX_MONEY + 1]) {
    assert.throws(() => calculateQuote([{ ...item, unitPricePaise: price }]), RangeError);
  }
  assert.throws(() => calculateQuote([item], -1), RangeError);
  assert.throws(() => calculateQuote([item], 0, -1), RangeError);
});
test("line multiplication and total addition enforce the money ceiling", () => {
  const item = { sku: "a", quantity: 1, unitPricePaise: MAX_MONEY, taxRateBps: 0 };
  assert.equal(calculateQuote([item]).totalPaise, MAX_MONEY);
  assert.throws(() => calculateQuote([{ ...item, quantity: 2 }]), RangeError);
  assert.throws(() => calculateQuote([item, { ...item, sku: "b" }]), RangeError);
  assert.throws(() => calculateQuote([item], 1), RangeError);
});
