function isUnlimited(value) {
  return value === null;
}

function isLimitAvailable(value) {
  if (value === null) return true;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

module.exports = { isUnlimited, isLimitAvailable };

