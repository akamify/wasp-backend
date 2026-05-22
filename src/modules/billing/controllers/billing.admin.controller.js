const billingService = require("@modules/billing/services/billing.admin.service");

async function adminSubscriptionPlans(req, res) {
  res.json(await billingService.subscriptionPlans());
}

async function adminSubscriptionsData(req, res) {
  res.json(await billingService.subscriptionsData(req));
}

async function adminPaymentGateway(req, res) {
  res.json(await billingService.paymentGateway(req));
}

async function adminSubscriptionWorkspaceOverview(req, res) {
  res.json(await billingService.getWorkspaceSubscriptionOverview(req));
}

async function adminSubscriptionWorkspaceHistory(req, res) {
  res.json(await billingService.listWorkspaceSubscriptionHistory(req));
}

async function adminSubscriptionWorkspacePaymentLinks(req, res) {
  res.json(await billingService.listWorkspacePaymentLinks(req));
}

async function adminAssignPlanToWorkspace(req, res) {
  res.json(await billingService.assignPlanToWorkspace(req));
}

async function adminCreateWorkspacePaymentLink(req, res) {
  res.json(await billingService.createWorkspacePaymentLink(req));
}

async function adminCancelWorkspacePaymentLink(req, res) {
  res.json(await billingService.cancelWorkspacePaymentLink(req));
}

async function adminDisableActiveWorkspacePlan(req, res) {
  res.json(await billingService.disableActivePlanForWorkspace(req));
}

module.exports = {
  adminSubscriptionPlans,
  adminSubscriptionsData,
  adminSubscriptionWorkspaceOverview,
  adminSubscriptionWorkspaceHistory,
  adminSubscriptionWorkspacePaymentLinks,
  adminAssignPlanToWorkspace,
  adminCreateWorkspacePaymentLink,
  adminCancelWorkspacePaymentLink,
  adminDisableActiveWorkspacePlan,
  adminPaymentGateway,
};

