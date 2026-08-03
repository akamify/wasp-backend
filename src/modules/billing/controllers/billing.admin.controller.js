const billingService = require("@modules/billing/services/billing.admin.service");
const { writeAuditLog } = require("@shared/services/auditLog.service");

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

async function superAdminActivateWorkspacePlan(req, res) {
  const out = await billingService.activateWorkspacePlanForWorkspace(req);
  await writeAuditLog(req, {
    action: "workspace.plan_activated",
    resourceType: "workspace",
    resourceId: String(req.params.workspaceId || ""),
    metadata: {
      workspaceId: String(req.params.workspaceId || ""),
      reason: String(req.body?.reason || "").trim(),
      before: out?.data?.before || null,
      after: out?.data?.after || null,
    },
  });
  res.json(out);
}

async function superAdminBlockWorkspacePlan(req, res) {
  const out = await billingService.blockWorkspacePlanAccess(req);
  await writeAuditLog(req, {
    action: "workspace.blocked",
    resourceType: "workspace",
    resourceId: String(req.params.workspaceId || ""),
    metadata: {
      workspaceId: String(req.params.workspaceId || ""),
      reason: String(req.body?.reason || "").trim(),
      before: out?.data?.before || null,
      after: out?.data?.after || null,
    },
  });
  res.json(out);
}

async function superAdminDeleteWorkspacePlanAssignment(req, res) {
  const out = await billingService.deleteWorkspacePlanAssignment(req);
  await writeAuditLog(req, {
    action: "workspace.plan_assignment_deleted",
    resourceType: "workspace",
    resourceId: String(req.params.workspaceId || ""),
    metadata: {
      workspaceId: String(req.params.workspaceId || ""),
      reason: String(req.body?.reason || "").trim(),
      before: out?.data?.before || null,
      after: out?.data?.after || null,
    },
  });
  res.json(out);
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
  superAdminActivateWorkspacePlan,
  superAdminBlockWorkspacePlan,
  superAdminDeleteWorkspacePlanAssignment,
  adminPaymentGateway,
};

