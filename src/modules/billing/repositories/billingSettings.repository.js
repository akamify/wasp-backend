const { BillingSettings } = require("@infra/database/BillingSettings");

async function getSingleton() {
  const row = await BillingSettings.findOne().sort({ createdAt: 1 });
  if (row) return row;
  return BillingSettings.create({});
}

async function upsertSingleton(update) {
  const existing = await getSingleton();
  Object.assign(existing, update || {});
  await existing.save();
  return existing;
}

module.exports = { getSingleton, upsertSingleton };
