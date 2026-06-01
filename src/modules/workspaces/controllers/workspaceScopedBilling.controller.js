const { currentSubscription } = require("@modules/billing/services/subscription.service");
const walletApi = require("@modules/wallet/services/wallet.api.service");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");

function withWorkspace(req, workspaceId) {
  return { ...req, workspace: { ...(req.workspace || {}), id: String(workspaceId) } };
}

async function currentBilling(req, res) {
  await requireWorkspacePermission(req.params.workspaceId, "billing.view", req.user.id);
  res.json(await currentSubscription(withWorkspace(req, req.params.workspaceId)));
}

async function currentWallet(req, res) {
  await requireWorkspacePermission(req.params.workspaceId, "billing.view", req.user.id);
  res.json(await walletApi.getWallet(withWorkspace(req, req.params.workspaceId)));
}

module.exports = { currentBilling, currentWallet };
