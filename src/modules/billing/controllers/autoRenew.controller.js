const autoRenewService = require("@modules/billing/services/billing.autoRenew.service");

async function enableAutoRenew(req, res) {
  res.json(await autoRenewService.enableAutoRenew(req));
}

async function confirmAutoRenew(req, res) {
  res.json(await autoRenewService.confirmAutoRenew(req));
}

async function disableAutoRenew(req, res) {
  res.json(await autoRenewService.disableAutoRenew(req));
}

async function toggleAutoRenew(req, res) {
  res.json(await autoRenewService.toggleAutoRenew(req));
}

async function renewalSettings(req, res) {
  res.json(await autoRenewService.autoRenewSettings(req));
}

module.exports = { enableAutoRenew, confirmAutoRenew, disableAutoRenew, toggleAutoRenew, renewalSettings };
