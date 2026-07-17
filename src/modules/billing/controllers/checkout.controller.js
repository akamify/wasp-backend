const checkoutService = require("@modules/billing/services/billing.checkout.service");

async function createCheckout(req, res) {
  res.json(await checkoutService.createCheckout(req));
}

async function verifyPayment(req, res) {
  res.json(await checkoutService.verifyPayment(req));
}

module.exports = { createCheckout, verifyPayment };
