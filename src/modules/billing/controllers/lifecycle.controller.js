const lifecycleService = require("@modules/billing/services/billing.lifecycle.service");

async function scheduleDowngrade(req, res) {
  res.json(await lifecycleService.scheduleDowngrade(req));
}

async function cancelScheduledChange(req, res) {
  res.json(await lifecycleService.cancelScheduledChange(req));
}

async function listInvoices(req, res) {
  res.json(await lifecycleService.listInvoices(req));
}

async function listTimeline(req, res) {
  res.json(await lifecycleService.listTimeline(req));
}

async function createRenewalPaymentOrder(req, res) {
  res.json(await lifecycleService.createRenewalPaymentOrder(req));
}

async function getRenewalStatus(req, res) {
  res.json(await lifecycleService.getRenewalStatus(req));
}

module.exports = {
  scheduleDowngrade,
  cancelScheduledChange,
  listInvoices,
  listTimeline,
  createRenewalPaymentOrder,
  getRenewalStatus,
};
