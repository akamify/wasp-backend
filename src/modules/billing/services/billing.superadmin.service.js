const { HttpError } = require("@shared/utils/httpError");
const { Plan } = require("@infra/database/Plan");
const { planRepository, billingSettingsRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { FEATURE_FUNCTIONALITY_KEYS, LIMIT_KEYS } = require("@modules/billing/constants/planFeatureKeys");
const { PLAN_STATUSES } = require("@modules/billing/constants/planStatuses");

function sanitizeSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-\s]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function toPaiseFromRupees(value) {
  if (value === null || value === "" || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "Invalid rupee amount");
  return Math.round(n * 100);
}

function normalizeLimit(value) {
  if (value === null || value === "" || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "Invalid limit value");
  return Math.round(n);
}

function normalizeLimitKey(value) {
  const key = String(value || "").trim();
  if (key === "maxExportsPerMonth") return "maxContactsExport";
  return key;
}

function deriveFromFeatureRows(featureRows) {
  const rows = Array.isArray(featureRows) ? featureRows : [];
  const sorted = rows.slice().sort((a, b) => Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0));
  const features = {};
  FEATURE_FUNCTIONALITY_KEYS.forEach((k) => {
    features[k] = false;
  });
  const limits = {};
  LIMIT_KEYS.forEach((k) => {
    limits[k] = 0;
  });
  const displayFeatures = [];
  const unavailableFeatures = [];
  const usedFunctionality = new Set();
  const usedLimits = new Set();
  const seenDisplayLabels = new Set();
  const seenUnavailableLabels = new Set();

  for (const row of sorted) {
    const label = String(row?.label || "").trim();
    const type = String(row?.type || "");
    const included = row?.included !== false;
    if (!label) throw new HttpError(400, "Feature row label is required");
    if (!["functionality", "limit", "text"].includes(type)) throw new HttpError(400, `Invalid feature row type: ${type}`);

    if (type === "functionality") {
      const key = String(row?.functionalityKey || "").trim();
      if (!FEATURE_FUNCTIONALITY_KEYS.includes(key)) throw new HttpError(400, `Unknown functionalityKey: ${key}`);
      if (usedFunctionality.has(key)) throw new HttpError(400, `Duplicate functionalityKey: ${key}`);
      usedFunctionality.add(key);
      features[key] = included;
    }

    if (type === "limit") {
      const limitKey = normalizeLimitKey(row?.limitKey);
      if (!LIMIT_KEYS.includes(limitKey)) throw new HttpError(400, `Unknown limitKey: ${limitKey}`);
      if (usedLimits.has(limitKey)) throw new HttpError(400, `Duplicate limitKey: ${limitKey}`);
      usedLimits.add(limitKey);
      const value = normalizeLimit(row?.value);
      limits[limitKey] = included ? value : 0;
    }

    if (included) {
      if (!seenDisplayLabels.has(label)) {
        displayFeatures.push(label);
        seenDisplayLabels.add(label);
      }
    } else if (!seenUnavailableLabels.has(label)) {
      unavailableFeatures.push(label);
      seenUnavailableLabels.add(label);
    }
  }

  // Auto-enable dependent capabilities from page-access toggles.
  if (features.campaignsPageAccess) features.campaignApiAccess = true;
  if (features.crmPageAccess) features.crmAccess = true;
  if (features.automationPageAccess) features.automationAccess = true;
  if (features.apiReportsPageAccess) features.analyticsAccess = true;
  if (features.inboxPageAccess) features.apiKeyAccess = true;

  return { featureRows: sorted, features, limits, displayFeatures, unavailableFeatures };
}

function calculatePlanPreview(pricing) {
  return calculatePrice({
    originalPricePaise: pricing.originalPricePaise,
    discountedPricePaise: pricing.discountedPricePaise,
    gstPercent: pricing.gstPercent,
    taxMode: pricing.taxMode,
  });
}

function mapPlan(plan) {
  const pricing = plan?.pricing || {};
  const preview = calculatePlanPreview({
    originalPricePaise: pricing.originalPricePaise,
    discountedPricePaise: pricing.discountedPricePaise,
    gstPercent: pricing.gstPercent == null ? 18 : Number(pricing.gstPercent),
    taxMode: pricing.taxMode || "exclusive",
  });
  return {
    id: String(plan._id),
    slug: plan.slug,
    name: plan.name,
    description: plan.description || "",
    pricing: {
      currency: pricing.currency || "INR",
      originalPricePaise: pricing.originalPricePaise,
      discountedPricePaise: pricing.discountedPricePaise,
      gstPercent: pricing.gstPercent,
      taxMode: pricing.taxMode,
      discountAmountPaise: preview.discountAmountPaise,
      discountPercent: preview.discountPercent,
      gstAmountPaise: preview.gstAmountPaise,
      payableAmountPaise: preview.payableAmountPaise,
    },
    buttonText: plan.buttonText || "",
    badgeText: plan.badgeText || (preview.discountAmountPaise > 0 ? `Save ₹${Math.round(preview.discountAmountPaise / 100).toLocaleString("en-IN")}` : ""),
    status: plan.status,
    publicVisible: Boolean(plan.publicVisible),
    purchasable: Boolean(plan.purchasable),
    recommended: Boolean(plan.recommended),
    sortOrder: Number(plan.sortOrder || 1),
    featureRows: Array.isArray(plan.featureRows) ? plan.featureRows : [],
    features: plan.features || {},
    limits: {
      ...(plan.limits || {}),
      maxContactsExport:
        (plan.limits || {}).maxContactsExport == null
          ? ((plan.limits || {}).maxExportsPerMonth ?? 0)
          : (plan.limits || {}).maxContactsExport,
    },
    displayFeatures: Array.isArray(plan.displayFeatures) ? plan.displayFeatures : [],
    unavailableFeatures: Array.isArray(plan.unavailableFeatures) ? plan.unavailableFeatures : [],
    review: plan.review || {},
    version: Number(plan.version || 1),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function mapPricePayload(payload) {
  const gstPercent = payload.gstPercent == null ? 18 : Number(payload.gstPercent);
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) {
    throw new HttpError(400, "Invalid GST percent");
  }
  return {
    currency: "INR",
    originalPricePaise: toPaiseFromRupees(payload.originalPriceRupees),
    discountedPricePaise: toPaiseFromRupees(payload.discountedPriceRupees),
    gstPercent,
    taxMode: "exclusive",
  };
}

function parseSortOrder(value, fallback = 1) {
  const parsed = value === undefined || value === null || value === "" ? Number(fallback) : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new HttpError(400, "sortOrder must be between 1 and 5");
  }
  return parsed;
}

async function listPlans({ query = {}, includeArchived = false } = {}) {
  const q = String(query.q || "").trim();
  const status = String(query.status || "").trim();
  const filter = { deletedAt: null };
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { slug: rx }, { description: rx }];
  }
  if (!includeArchived && !filter.status) filter.status = { $in: [PLAN_STATUSES.IN_REVIEW, PLAN_STATUSES.PUBLISHED, PLAN_STATUSES.DISABLED] };
  const plans = await Plan.find(filter).sort({ sortOrder: 1, createdAt: -1 });
  return { success: true, message: "Plans fetched successfully.", data: { items: plans.map(mapPlan) } };
}

async function getPlan(planId) {
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  return { success: true, message: "Plan fetched successfully.", data: { item: mapPlan(plan) } };
}

async function createPlan({ actorId, payload }) {
  const slug = sanitizeSlug(payload.slug || payload.name);
  if (!slug) throw new HttpError(400, "Slug is required");
  const exists = await planRepository.findBySlug(slug);
  if (exists) throw new HttpError(409, "Plan slug already exists");

  const derived = deriveFromFeatureRows(payload.featureRows || []);
  const pricing = mapPricePayload(payload);
  const computed = calculatePlanPreview(pricing);

  const doc = await Plan.create({
    slug,
    name: String(payload.name || "").trim(),
    description: String(payload.description || "").trim(),
    pricing,
    computedPreviewSnapshot: {
      discountAmountPaise: computed.discountAmountPaise,
      discountPercent: computed.discountPercent,
      gstAmountPaise: computed.gstAmountPaise,
      payableAmountPaise: computed.payableAmountPaise,
    },
    buttonText: String(payload.buttonText || "").trim(),
    badgeText: String(payload.badgeText || "").trim(),
    status: PLAN_STATUSES.IN_REVIEW,
    publicVisible: true,
    purchasable: true,
    recommended: Boolean(payload.recommended),
    sortOrder: parseSortOrder(payload.sortOrder),
    featureRows: derived.featureRows,
    features: derived.features,
    limits: derived.limits,
    displayFeatures: derived.displayFeatures,
    unavailableFeatures: derived.unavailableFeatures,
    review: { submittedAt: new Date(), reviewNote: String(payload.reviewNote || "").trim() },
    createdBy: actorId || null,
    updatedBy: actorId || null,
  });
  if (doc.recommended) {
    await planRepository.clearRecommendedExcept(doc._id);
  }

  return { success: true, message: "Plan created in review.", data: { item: mapPlan(doc) } };
}

async function updatePlan({ actorId, planId, payload }) {
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");

  const derived = deriveFromFeatureRows(payload.featureRows || plan.featureRows || []);
  const pricing = mapPricePayload({
    originalPriceRupees: payload.originalPriceRupees ?? (plan.pricing?.originalPricePaise == null ? null : Number(plan.pricing.originalPricePaise) / 100),
    discountedPriceRupees: payload.discountedPriceRupees ?? (plan.pricing?.discountedPricePaise == null ? null : Number(plan.pricing.discountedPricePaise) / 100),
    gstPercent: payload.gstPercent ?? plan.pricing?.gstPercent ?? 18,
    taxMode: payload.taxMode ?? plan.pricing?.taxMode ?? "exclusive",
  });
  const computed = calculatePlanPreview(pricing);

  plan.name = String(payload.name || plan.name || "").trim();
  plan.description = String(payload.description ?? plan.description ?? "").trim();
  plan.pricing = pricing;
  plan.computedPreviewSnapshot = {
    discountAmountPaise: computed.discountAmountPaise,
    discountPercent: computed.discountPercent,
    gstAmountPaise: computed.gstAmountPaise,
    payableAmountPaise: computed.payableAmountPaise,
  };
  plan.buttonText = String(payload.buttonText ?? plan.buttonText ?? "").trim();
  plan.badgeText = String(payload.badgeText ?? "").trim();
  plan.publicVisible = true;
  plan.purchasable = true;
  plan.recommended = payload.recommended === undefined ? plan.recommended : Boolean(payload.recommended);
  plan.sortOrder = payload.sortOrder === undefined ? plan.sortOrder : parseSortOrder(payload.sortOrder, plan.sortOrder || 1);
  plan.featureRows = derived.featureRows;
  plan.features = derived.features;
  plan.limits = derived.limits;
  plan.displayFeatures = derived.displayFeatures;
  plan.unavailableFeatures = derived.unavailableFeatures;

  plan.status = PLAN_STATUSES.IN_REVIEW;

  plan.updatedBy = actorId || null;
  await plan.save();
  if (plan.recommended) {
    await planRepository.clearRecommendedExcept(plan._id);
  }
  return { success: true, message: "Plan updated and moved to in_review.", data: { item: mapPlan(plan) } };
}

async function submitReview({ actorId, planId, payload }) {
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  plan.status = PLAN_STATUSES.IN_REVIEW;
  plan.review = { ...(plan.review || {}), submittedAt: new Date(), reviewedBy: actorId || null, reviewNote: String(payload?.reviewNote || "").trim() };
  plan.updatedBy = actorId || null;
  await plan.save();
  return { success: true, message: "Plan submitted for review.", data: { item: mapPlan(plan) } };
}

async function publishPlan({ actorId, planId, payload }) {
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  plan.publicVisible = true;
  plan.purchasable = true;
  plan.status = PLAN_STATUSES.PUBLISHED;
  plan.review = { ...(plan.review || {}), publishedAt: new Date(), reviewedBy: actorId || null, reviewNote: String(payload?.reviewNote || plan.review?.reviewNote || "") };
  plan.updatedBy = actorId || null;
  await plan.save();
  if (plan.recommended) {
    await planRepository.clearRecommendedExcept(plan._id);
  }
  return { success: true, message: "Plan published successfully.", data: { item: mapPlan(plan) } };
}

async function disablePlan({ actorId, planId }) {
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  plan.status = PLAN_STATUSES.DISABLED;
  plan.publicVisible = false;
  plan.purchasable = false;
  plan.updatedBy = actorId || null;
  await plan.save();
  return { success: true, message: "Plan disabled.", data: { item: mapPlan(plan) } };
}

async function getBillingSettings() {
  const settings = await billingSettingsRepository.getSingleton();
  return { success: true, message: "Billing settings fetched.", data: { item: settings } };
}

async function updateBillingSettings({ actorId, payload }) {
  const row = await billingSettingsRepository.upsertSingleton({
    currency: "INR",
    defaultGstPercent: payload.defaultGstPercent == null ? 18 : Number(payload.defaultGstPercent),
    taxMode: "exclusive",
    updatedBy: actorId || null,
  });
  return { success: true, message: "Billing settings updated.", data: { item: row } };
}

async function pricePreview({ payload }) {
  const pricing = mapPricePayload(payload || {});
  const preview = calculatePlanPreview(pricing);
  return { success: true, message: "Price preview generated.", data: { pricing, preview } };
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  submitReview,
  publishPlan,
  disablePlan,
  getBillingSettings,
  updateBillingSettings,
  pricePreview,
};
