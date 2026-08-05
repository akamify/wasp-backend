const { HttpError } = require("@shared/utils/httpError");
const { Plan } = require("@infra/database/Plan");
const { planRepository, billingSettingsRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { FEATURE_FUNCTIONALITY_KEYS, LIMIT_KEYS } = require("@modules/billing/constants/planFeatureKeys");
const { PLAN_STATUSES } = require("@modules/billing/constants/planStatuses");
const {
  getFreePlanConfig,
  FREE_PLAN_DISPLAY_FEATURES,
  FREE_PLAN_UNAVAILABLE_FEATURES,
} = require("@modules/billing/services/freePlan.service");

const FREE_PLAN_ID = "free-plan";
const BILLING_CYCLES = Object.freeze(["monthly", "quarterly", "yearly", "lifetime"]);
const TAX_MODES = Object.freeze(["exclusive", "inclusive", "none"]);
const BADGE_TYPES = Object.freeze(["none", "popular", "best_value", "recommended", "limited_offer", "enterprise", "coming_soon"]);
const CARD_COLORS = Object.freeze(["blue", "green", "purple", "gold", "slate"]);
const PLAN_SLOTS = Object.freeze([
  { name: "Free", slug: "free", sortOrder: 1 },
  { name: "Basic", slug: "basic", sortOrder: 2 },
  { name: "Pro", slug: "pro", sortOrder: 3 },
  { name: "Premium", slug: "premium", sortOrder: 4 },
  { name: "Unlimited", slug: "unlimited", sortOrder: 5 },
]);
const DEFAULT_CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || "\u20b9";

function sanitizeSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-\s]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function resolvePlanSlot(payload = {}) {
  const requestedSlug = sanitizeSlug(payload.slug || payload.name);
  const requestedName = String(payload.name || "").trim().toLowerCase();
  const compactSlug = requestedSlug.replace(/-?plan$/, "").replace(/-/g, "");
  const compactName = requestedName.replace(/\s+plan$/, "").replace(/\s+/g, "");
  const slot = PLAN_SLOTS.find((item) => item.slug === requestedSlug || item.slug === compactSlug || item.name.toLowerCase() === requestedName || item.name.toLowerCase() === compactName);
  if (!slot) throw new HttpError(400, "Only Free, Basic, Pro, Premium, and Unlimited plans can be created.");
  return slot;
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
  if (key === "maxEmployees") return "maxAgents";
  return key;
}

function normalizeFeatures(raw = {}) {
  const features = {};
  FEATURE_FUNCTIONALITY_KEYS.forEach((key) => {
    features[key] = Boolean(raw?.[key]);
  });
  if (features.campaignsPageAccess) {
    features.whatsAppBroadcastAccess = true;
    features.smartCampaignManagerAccess = true;
  }
  if (features.crmPageAccess) features.crmAccess = true;
  if (features.automationPageAccess || features.flowsPageAccess) features.automationAccess = true;
  if (features.apiReportsPageAccess) features.analyticsAccess = true;
  if (features.apiKeysPageAccess || features.inboxPageAccess) features.apiKeyAccess = true;
  if (features.inboxPageAccess) features.liveChatAccess = true;
  return features;
}

function normalizeLimits(raw = {}) {
  const limits = {};
  LIMIT_KEYS.forEach((key) => {
    const sourceKey = key === "maxAgents" && raw?.maxAgents === undefined ? "maxEmployees" : key;
    limits[key] = normalizeLimit(raw?.[sourceKey]);
  });
  limits.maxAgents = limits.maxAgents ?? normalizeLimit(raw.maxEmployees) ?? 0;
  limits.maxEmployees = limits.maxAgents;
  limits.maxContactsExport = limits.maxContactsExport ?? normalizeLimit(raw.maxExportsPerMonth) ?? 0;
  return limits;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const label = String(item || "").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.slice(0, 80);
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
  limits.maxAgents = limits.maxAgents ?? limits.maxEmployees ?? 0;
  limits.maxEmployees = limits.maxAgents;

  return { featureRows: sorted, features, limits, displayFeatures, unavailableFeatures };
}

function buildStructuredEntitlements(payload = {}, fallback = {}) {
  const hasStructured = Boolean(payload.features || payload.limits || payload.displayFeatures || payload.unavailableFeatures || payload.addonServices);
  if (!hasStructured) {
    const derived = deriveFromFeatureRows(payload.featureRows || fallback.featureRows || []);
    return { ...derived, features: normalizeFeatures(derived.features) };
  }
  const derivedRows = deriveFromFeatureRows(payload.featureRows || fallback.featureRows || []);
  const displayFeatures = normalizeStringArray(payload.displayFeatures);
  const unavailableFeatures = normalizeStringArray(payload.unavailableFeatures);
  return {
    featureRows: Array.isArray(payload.featureRows) ? payload.featureRows : (fallback.featureRows || []),
    features: normalizeFeatures({ ...derivedRows.features, ...(fallback.features || {}), ...(payload.features || {}) }),
    limits: normalizeLimits({ ...derivedRows.limits, ...(fallback.limits || {}), ...(payload.limits || {}) }),
    displayFeatures: displayFeatures.length ? displayFeatures : derivedRows.displayFeatures,
    unavailableFeatures: unavailableFeatures.length ? unavailableFeatures : derivedRows.unavailableFeatures,
  };
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
  const limitValue = (primary, fallback) => (primary === null ? null : (primary === undefined ? fallback : primary));
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
      billingCycle: pricing.billingCycle || "monthly",
      discountAmountPaise: preview.discountAmountPaise,
      discountPercent: preview.discountPercent,
      gstAmountPaise: preview.gstAmountPaise,
      payableAmountPaise: preview.payableAmountPaise,
    },
    trial: {
      enabled: Boolean(plan.trial?.enabled),
      days: Number(plan.trial?.days || 0),
    },
    buttonText: plan.buttonText || "",
    badgeText: plan.badgeText || (preview.discountAmountPaise > 0 ? `Save ${DEFAULT_CURRENCY_SYMBOL}${Math.round(preview.discountAmountPaise / 100).toLocaleString("en-IN")}` : ""),
    badgeType: plan.badgeType || "none",
    cardColor: plan.cardColor || "blue",
    icon: plan.icon || "⭐",
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
        limitValue((plan.limits || {}).maxContactsExport, (plan.limits || {}).maxExportsPerMonth ?? 0),
      maxAgents: limitValue((plan.limits || {}).maxAgents, (plan.limits || {}).maxEmployees ?? 0),
    },
    displayFeatures: Array.isArray(plan.displayFeatures) ? plan.displayFeatures : [],
    unavailableFeatures: Array.isArray(plan.unavailableFeatures) ? plan.unavailableFeatures : [],
    addonServices: Array.isArray(plan.addonServices) ? plan.addonServices : [],
    review: plan.review || {},
    version: Number(plan.version || 1),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function mapFreePlan(freeConfig) {
  return {
    id: FREE_PLAN_ID,
    slug: "free",
    name: String(freeConfig?.name || "Free"),
    description: String(freeConfig?.description || ""),
    pricing: {
      currency: "INR",
      originalPricePaise: null,
      discountedPricePaise: null,
      gstPercent: 0,
      taxMode: "exclusive",
      billingCycle: "monthly",
      discountAmountPaise: 0,
      discountPercent: 0,
      gstAmountPaise: 0,
      payableAmountPaise: 0,
    },
    trial: { enabled: false, days: 0 },
    buttonText: String(freeConfig?.buttonText || "Current Plan"),
    badgeText: "Free",
    badgeType: "none",
    cardColor: "green",
    icon: "A",
    status: PLAN_STATUSES.PUBLISHED,
    publicVisible: true,
    purchasable: false,
    recommended: false,
    sortOrder: 1,
    featureRows: Array.isArray(freeConfig?.featureRows) ? freeConfig.featureRows : [],
    features: { ...(freeConfig?.features || {}) },
    limits: { ...(freeConfig?.limits || {}) },
    displayFeatures: Array.isArray(freeConfig?.displayFeatures) && freeConfig.displayFeatures.length
      ? [...freeConfig.displayFeatures]
      : [...FREE_PLAN_DISPLAY_FEATURES],
    unavailableFeatures: Array.isArray(freeConfig?.unavailableFeatures) && freeConfig.unavailableFeatures.length
      ? [...freeConfig.unavailableFeatures]
      : [...FREE_PLAN_UNAVAILABLE_FEATURES],
    addonServices: Array.isArray(freeConfig?.addonServices) ? [...freeConfig.addonServices] : [],
    review: {},
    version: 1,
    createdAt: null,
    updatedAt: null,
    isSystem: true,
    isFreePlan: true,
  };
}

function mapPricePayload(payload) {
  const gstPercent = payload.gstPercent == null ? 18 : Number(payload.gstPercent);
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) {
    throw new HttpError(400, "Invalid GST percent");
  }
  const taxMode = String(payload.taxMode || "exclusive").trim();
  if (!TAX_MODES.includes(taxMode)) throw new HttpError(400, "Invalid tax mode");
  const billingCycle = String(payload.billingCycle || "monthly").trim();
  if (!BILLING_CYCLES.includes(billingCycle)) throw new HttpError(400, "Invalid billing cycle");
  const originalPricePaise = toPaiseFromRupees(payload.originalPriceRupees);
  const discountedPricePaise = toPaiseFromRupees(payload.discountedPriceRupees);
  if (originalPricePaise == null || discountedPricePaise == null) throw new HttpError(400, "Original and discounted price are required");
  if (discountedPricePaise > originalPricePaise) throw new HttpError(400, "Discounted price cannot be greater than original price");
  return {
    currency: "INR",
    originalPricePaise,
    discountedPricePaise,
    gstPercent,
    taxMode,
    billingCycle,
  };
}

function normalizePlanMeta(payload, fallback = {}) {
  const status = String(payload.status ?? fallback.status ?? PLAN_STATUSES.IN_REVIEW).trim();
  if (!Object.values(PLAN_STATUSES).includes(status)) throw new HttpError(400, "Invalid plan status");
  const badgeType = String(payload.badgeType ?? fallback.badgeType ?? "none").trim();
  if (!BADGE_TYPES.includes(badgeType)) throw new HttpError(400, "Invalid badge type");
  const cardColor = String(payload.cardColor ?? fallback.cardColor ?? "blue").trim();
  if (!CARD_COLORS.includes(cardColor)) throw new HttpError(400, "Invalid card color");
  const trialEnabled = Boolean(payload.trial?.enabled ?? payload.trialEnabled ?? fallback.trial?.enabled ?? false);
  const trialDays = Number(payload.trial?.days ?? payload.trialDays ?? fallback.trial?.days ?? 0);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw new HttpError(400, "Trial days must be between 0 and 365");
  if (trialEnabled && trialDays < 1) throw new HttpError(400, "Trial days are required when trial is enabled");
  return {
    status,
    publicVisible: payload.publicVisible === undefined ? Boolean(fallback.publicVisible ?? true) : Boolean(payload.publicVisible),
    purchasable: payload.purchasable === undefined ? Boolean(fallback.purchasable ?? true) : Boolean(payload.purchasable),
    recommended: payload.recommended === undefined ? Boolean(fallback.recommended ?? false) : Boolean(payload.recommended),
    badgeType,
    cardColor,
    icon: String(payload.icon ?? fallback.icon ?? "⭐").trim().slice(0, 8) || "⭐",
    trial: { enabled: trialEnabled, days: trialEnabled ? trialDays : 0 },
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
  const plans = (await Plan.find(filter).sort({ sortOrder: 1, createdAt: -1 })).filter(
    (plan) => String(plan?.slug || "").toLowerCase() !== "free"
  );
  const freeConfig = await getFreePlanConfig();
  const items = [mapFreePlan(freeConfig), ...plans.map(mapPlan)];
  items.sort((a, b) => {
    const aOrder = Number(a?.sortOrder ?? 999);
    const bOrder = Number(b?.sortOrder ?? 999);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
  return { success: true, message: "Plans fetched successfully.", data: { items } };
}

async function getPlan(planId) {
  if (String(planId) === FREE_PLAN_ID) {
    const freeConfig = await getFreePlanConfig();
    return { success: true, message: "Plan fetched successfully.", data: { item: mapFreePlan(freeConfig) } };
  }
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  return { success: true, message: "Plan fetched successfully.", data: { item: mapPlan(plan) } };
}

async function updateFreePlan({ actorId, payload }) {
  const current = await getFreePlanConfig();
  const entitlements = buildStructuredEntitlements(payload, current);
  const limits = {
    maxContacts:
      payload?.limits?.maxContacts === undefined
        ? current.limits.maxContacts
        : normalizeLimit(payload?.limits?.maxContacts),
    maxTemplates:
      payload?.limits?.maxTemplates === undefined
        ? current.limits.maxTemplates
        : normalizeLimit(payload?.limits?.maxTemplates),
    maxCampaignsPerMonth:
      payload?.limits?.maxCampaignsPerMonth === undefined
        ? current.limits.maxCampaignsPerMonth
        : normalizeLimit(payload?.limits?.maxCampaignsPerMonth),
    maxContactsExport:
      payload?.limits?.maxContactsExport === undefined
        ? current.limits.maxContactsExport
        : normalizeLimit(payload?.limits?.maxContactsExport),
    maxAgents:
      payload?.limits?.maxAgents === undefined
        ? current.limits.maxAgents
        : normalizeLimit(payload?.limits?.maxAgents),
    maxTags:
      payload?.limits?.maxTags === undefined
        ? current.limits.maxTags
        : normalizeLimit(payload?.limits?.maxTags),
    maxCustomAttributes:
      payload?.limits?.maxCustomAttributes === undefined
        ? current.limits.maxCustomAttributes
        : normalizeLimit(payload?.limits?.maxCustomAttributes),
    maxWebhooks:
      payload?.limits?.maxWebhooks === undefined
        ? current.limits.maxWebhooks
        : normalizeLimit(payload?.limits?.maxWebhooks),
    messageRatePerSec:
      payload?.limits?.messageRatePerSec === undefined
        ? current.limits.messageRatePerSec
        : normalizeLimit(payload?.limits?.messageRatePerSec),
    maxFlows:
      payload?.limits?.maxFlows === undefined
        ? current.limits.maxFlows
        : normalizeLimit(payload?.limits?.maxFlows),
    maxTeams:
      payload?.limits?.maxTeams === undefined
        ? current.limits.maxTeams
        : normalizeLimit(payload?.limits?.maxTeams),
    maxApiKeys:
      payload?.limits?.maxApiKeys === undefined
        ? current.limits.maxApiKeys
        : normalizeLimit(payload?.limits?.maxApiKeys),
    maxStorageMb:
      payload?.limits?.maxStorageMb === undefined
        ? current.limits.maxStorageMb
        : normalizeLimit(payload?.limits?.maxStorageMb),
    maxProjects:
      payload?.limits?.maxProjects === undefined
        ? current.limits.maxProjects
        : normalizeLimit(payload?.limits?.maxProjects),
    maxMediaSizeMb:
      payload?.limits?.maxMediaSizeMb === undefined
        ? current.limits.maxMediaSizeMb
        : normalizeLimit(payload?.limits?.maxMediaSizeMb),
    dailyMessageLimit:
      payload?.limits?.dailyMessageLimit === undefined
        ? current.limits.dailyMessageLimit
        : normalizeLimit(payload?.limits?.dailyMessageLimit),
  };

  await billingSettingsRepository.upsertSingleton({
    freePlan: {
      name: String(payload?.name || current.name || "Free").trim() || "Free",
      description: String(payload?.description ?? current.description ?? "").trim(),
      buttonText: String(payload?.buttonText || current.buttonText || "Current Plan").trim() || "Current Plan",
      features: entitlements.features,
      featureRows: entitlements.featureRows,
      displayFeatures: entitlements.displayFeatures,
      unavailableFeatures: entitlements.unavailableFeatures,
      addonServices: normalizeStringArray(payload?.addonServices ?? current.addonServices ?? []),
      limits,
    },
    updatedBy: actorId || null,
  });

  const updated = await getFreePlanConfig();
  return { success: true, message: "Free plan updated successfully.", data: { item: mapFreePlan(updated) } };
}

async function createPlan({ actorId, payload }) {
  const slot = resolvePlanSlot(payload);
  const slug = slot.slug;
  const exists = await Plan.findOne({
    deletedAt: null,
    $or: [
      { slug },
      { slug: `${slug}plan` },
      { slug: `${slug}-plan` },
      { name: slot.name },
      { name: `${slot.name} Plan` },
    ],
  });
  if (exists) throw new HttpError(409, `${slot.name} plan already exists`);

  const derived = buildStructuredEntitlements(payload);
  const pricing = mapPricePayload(payload);
  const computed = calculatePlanPreview(pricing);
  const meta = normalizePlanMeta(payload);

  const doc = await Plan.create({
    slug,
    name: slot.name,
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
    status: meta.status,
    publicVisible: meta.publicVisible,
    purchasable: meta.purchasable,
    recommended: meta.recommended,
    trial: meta.trial,
    badgeType: meta.badgeType,
    cardColor: meta.cardColor,
    icon: meta.icon,
    sortOrder: parseSortOrder(payload.sortOrder ?? slot.sortOrder),
    featureRows: derived.featureRows,
    features: derived.features,
    limits: derived.limits,
    displayFeatures: derived.displayFeatures,
    unavailableFeatures: derived.unavailableFeatures,
    addonServices: normalizeStringArray(payload.addonServices),
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
  if (String(planId) === FREE_PLAN_ID) {
    return updateFreePlan({ actorId, payload });
  }
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  const slot = resolvePlanSlot({ slug: plan.slug, name: plan.name });
  const previousRecurringConfig = JSON.stringify({
    name: String(plan.name || ""),
    description: String(plan.description || ""),
    pricing: {
      originalPricePaise: plan.pricing?.originalPricePaise ?? null,
      discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
      gstPercent: plan.pricing?.gstPercent ?? 18,
      taxMode: plan.pricing?.taxMode || "exclusive",
      billingCycle: plan.pricing?.billingCycle || "monthly",
    },
  });

  const derived = buildStructuredEntitlements(payload, plan);
  const pricing = mapPricePayload({
    originalPriceRupees: payload.originalPriceRupees ?? (plan.pricing?.originalPricePaise == null ? null : Number(plan.pricing.originalPricePaise) / 100),
    discountedPriceRupees: payload.discountedPriceRupees ?? (plan.pricing?.discountedPricePaise == null ? null : Number(plan.pricing.discountedPricePaise) / 100),
    gstPercent: payload.gstPercent ?? plan.pricing?.gstPercent ?? 18,
    taxMode: payload.taxMode ?? plan.pricing?.taxMode ?? "exclusive",
    billingCycle: payload.billingCycle ?? plan.pricing?.billingCycle ?? "monthly",
  });
  const computed = calculatePlanPreview(pricing);
  const meta = normalizePlanMeta(payload, plan);

  plan.slug = slot.slug;
  plan.name = slot.name;
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
  plan.publicVisible = meta.publicVisible;
  plan.purchasable = meta.purchasable;
  plan.recommended = meta.recommended;
  plan.trial = meta.trial;
  plan.badgeType = meta.badgeType;
  plan.cardColor = meta.cardColor;
  plan.icon = meta.icon;
  plan.sortOrder = payload.sortOrder === undefined ? (plan.sortOrder || slot.sortOrder) : parseSortOrder(payload.sortOrder, plan.sortOrder || slot.sortOrder);
  plan.featureRows = derived.featureRows;
  plan.features = derived.features;
  plan.limits = derived.limits;
  plan.displayFeatures = derived.displayFeatures;
  plan.unavailableFeatures = derived.unavailableFeatures;
  plan.addonServices = payload.addonServices === undefined ? (Array.isArray(plan.addonServices) ? plan.addonServices : []) : normalizeStringArray(payload.addonServices);

  plan.status = meta.status;

  plan.updatedBy = actorId || null;
  const nextRecurringConfig = JSON.stringify({
    name: String(plan.name || ""),
    description: String(plan.description || ""),
    pricing: {
      originalPricePaise: plan.pricing?.originalPricePaise ?? null,
      discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
      gstPercent: plan.pricing?.gstPercent ?? 18,
      taxMode: plan.pricing?.taxMode || "exclusive",
      billingCycle: plan.pricing?.billingCycle || "monthly",
    },
  });
  if (previousRecurringConfig !== nextRecurringConfig) {
    plan.razorpayPlanId = "";
    plan.razorpayPlanConfigHash = "";
    plan.razorpayPlanSyncedAt = null;
  }
  await plan.save();
  if (plan.recommended) {
    await planRepository.clearRecommendedExcept(plan._id);
  }
  return { success: true, message: "Plan updated and moved to in_review.", data: { item: mapPlan(plan) } };
}

async function submitReview({ actorId, planId, payload }) {
  if (String(planId) === FREE_PLAN_ID) {
    throw new HttpError(400, "Free plan does not use the review workflow. Save changes directly.");
  }
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  plan.status = PLAN_STATUSES.IN_REVIEW;
  plan.review = { ...(plan.review || {}), submittedAt: new Date(), reviewedBy: actorId || null, reviewNote: String(payload?.reviewNote || "").trim() };
  plan.updatedBy = actorId || null;
  await plan.save();
  return { success: true, message: "Plan submitted for review.", data: { item: mapPlan(plan) } };
}

async function publishPlan({ actorId, planId, payload }) {
  if (String(planId) === FREE_PLAN_ID) {
    throw new HttpError(400, "Free plan is a system plan and is already active.");
  }
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
  if (String(planId) === FREE_PLAN_ID) {
    throw new HttpError(400, "Free plan is a system plan and cannot be disabled.");
  }
  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  plan.status = PLAN_STATUSES.DISABLED;
  plan.publicVisible = false;
  plan.purchasable = false;
  plan.updatedBy = actorId || null;
  await plan.save();
  return { success: true, message: "Plan disabled.", data: { item: mapPlan(plan) } };
}

async function deletePlan({ actorId, planId }) {
  if (String(planId) === FREE_PLAN_ID) {
    throw new HttpError(400, "Free plan is a system plan and cannot be deleted.");
  }
  const plan = await planRepository.findById(planId);
  if (!plan) return { success: true, message: "Plan already deleted.", data: { item: { id: String(planId || ""), deleted: true } } };
  const originalSlug = plan.slug;
  plan.deletedAt = new Date();
  plan.deletedBy = actorId || null;
  plan.slug = `${String(plan.slug || "plan")}-deleted-${Date.now()}`;
  plan.publicVisible = false;
  plan.purchasable = false;
  plan.recommended = false;
  plan.updatedBy = actorId || null;
  await plan.save();
  return { success: true, message: "Plan deleted.", data: { item: { id: String(plan._id), slug: originalSlug } } };
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
  FREE_PLAN_ID,
  listPlans,
  getPlan,
  updateFreePlan,
  createPlan,
  updatePlan,
  submitReview,
  publishPlan,
  disablePlan,
  deletePlan,
  getBillingSettings,
  updateBillingSettings,
  pricePreview,
};
