function nextRetryDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  const delay = Math.min(30 * 60 * 1000, Math.pow(2, n - 1) * 30 * 1000);
  return delay;
}

module.exports = { nextRetryDelayMs };

