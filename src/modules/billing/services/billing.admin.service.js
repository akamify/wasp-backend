const { billingRepository } = require("@modules/billing/repositories/index");
const { billingValidation } = require("@modules/billing/validations/index");
const { listResponse } = require("@modules/billing/utils/listResponse");
const { mapWorkspaceSubscriptionItem, mapPlanSummaryItem } = require("@modules/billing/dto/billing.admin.dto");

async function subscriptionPlans() {
  const items = await billingRepository.aggregatePlans();
  return { success: true, items: items.map(mapPlanSummaryItem) };
}

async function subscriptionsData(req) {
  const { page, limit, skip, rx } = billingValidation.parseListQuery(req);
  const filter = rx ? { $or: [{ name: rx }, { plan: rx }] } : {};

  const { total, workspaces, planSummary } = await billingRepository.listSubscriptionsData({ filter, skip, limit });
  const ownerById = await billingRepository.loadOwnersForWorkspaces(workspaces);

  return Object.assign(
    listResponse({ items: workspaces.map((w) => mapWorkspaceSubscriptionItem(w, ownerById.get(String(w.ownerId)))), total, page, limit }),
    { summary: planSummary.map(mapPlanSummaryItem) }
  );
}

async function paymentGateway(req) {
  const { page, limit } = billingValidation.parsePaging(req);
  return listResponse({ items: [], total: 0, page, limit });
}

module.exports = { subscriptionPlans, subscriptionsData, paymentGateway };

