const walletApi = require("@modules/wallet/services/wallet.api.service");

async function getWallet(req, res) {
  res.json(await walletApi.getWallet(req));
}

async function createRechargeOrder(req, res) {
  res.json(await walletApi.createRechargeOrder(req));
}

async function walletHistory(req, res) {
  res.json(await walletApi.walletHistory(req));
}

async function razorpayWebhook(req, res) {
  res.json(await walletApi.razorpayWebhook(req));
}

module.exports = { getWallet, createRechargeOrder, walletHistory, razorpayWebhook };

