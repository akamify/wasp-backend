const planService = require("@modules/billing/services/plan.service");

async function listPlans(req, res) {
  res.json(await planService.listPublicPlans());
}

module.exports = { listPlans };

