const svc = require("@modules/billing/services/billing.superadmin.service");
const { writeAuditLog } = require("@shared/services/auditLog.service");

async function log(req, action, meta = {}) {
  await writeAuditLog(req, {
    action,
    targetType: "billing_plan",
    targetId: meta.planId || undefined,
    metadata: meta,
  });
}

async function listPlans(req, res) {
  res.json(await svc.listPlans({ query: req.query, includeArchived: false }));
}

async function getPlan(req, res) {
  res.json(await svc.getPlan(req.params.id));
}

async function createPlan(req, res) {
  const out = await svc.createPlan({ actorId: req.user?.id, payload: req.body || {} });
  const item = out?.data?.item || {};
  await log(req, "plan.created", { planId: item.id, slug: item.slug, status: item.status, actorId: req.user?.id || null });
  res.json(out);
}

async function updatePlan(req, res) {
  const out = await svc.updatePlan({ actorId: req.user?.id, planId: req.params.id, payload: req.body || {} });
  const item = out?.data?.item || {};
  await log(req, "plan.updated", { planId: item.id, slug: item.slug, status: item.status, actorId: req.user?.id || null });
  res.json(out);
}

async function reviewPlan(req, res) {
  const out = await svc.submitReview({ actorId: req.user?.id, planId: req.params.id, payload: req.body || {} });
  const item = out?.data?.item || {};
  await log(req, "plan.submitted_for_review", { planId: item.id, slug: item.slug, status: item.status, actorId: req.user?.id || null });
  res.json(out);
}

async function publishPlan(req, res) {
  const out = await svc.publishPlan({ actorId: req.user?.id, planId: req.params.id, payload: req.body || {} });
  const item = out?.data?.item || {};
  await log(req, "plan.published", { planId: item.id, slug: item.slug, status: item.status, actorId: req.user?.id || null });
  res.json(out);
}

async function disablePlan(req, res) {
  const out = await svc.disablePlan({ actorId: req.user?.id, planId: req.params.id });
  const item = out?.data?.item || {};
  await log(req, "plan.disabled", { planId: item.id, slug: item.slug, status: item.status, actorId: req.user?.id || null });
  res.json(out);
}

async function getBillingSettings(req, res) {
  res.json(await svc.getBillingSettings());
}

async function updateBillingSettings(req, res) {
  const out = await svc.updateBillingSettings({ actorId: req.user?.id, payload: req.body || {} });
  await writeAuditLog(req, { action: "billing_settings.updated", metadata: { actorId: req.user?.id || null } });
  res.json(out);
}

async function pricePreview(req, res) {
  res.json(await svc.pricePreview({ payload: req.body || {} }));
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  reviewPlan,
  publishPlan,
  disablePlan,
  getBillingSettings,
  updateBillingSettings,
  pricePreview,
};
