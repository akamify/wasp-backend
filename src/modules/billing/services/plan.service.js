const { planRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");

function mapPlan(plan) {
  const pricing = plan?.pricing || {};
  const breakdown = calculatePrice({
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
      originalPricePaise: breakdown.originalPricePaise,
      discountedPricePaise: breakdown.discountedPricePaise,
      discountAmountPaise: breakdown.discountAmountPaise,
      discountPercent: breakdown.discountPercent,
      gstPercent: breakdown.gstPercent,
      gstAmountPaise: breakdown.gstAmountPaise,
      payableAmountPaise: breakdown.payableAmountPaise,
      taxMode: breakdown.taxMode,
      billingCycle: pricing.billingCycle || "monthly",
    },
    trial: {
      enabled: Boolean(plan.trial?.enabled),
      days: Number(plan.trial?.days || 0),
    },
    buttonText: plan.buttonText || "Buy Now",
    badgeText: plan.badgeText || "",
    badgeType: plan.badgeType || "none",
    cardColor: plan.cardColor || "blue",
    icon: plan.icon || "⭐",
    recommended: Boolean(plan.recommended),
    sortOrder: Number(plan.sortOrder || 0),
    publicVisible: Boolean(plan.publicVisible),
    purchasable: Boolean(plan.purchasable),
    displayFeatures: Array.isArray(plan.displayFeatures) ? plan.displayFeatures : [],
    unavailableFeatures: Array.isArray(plan.unavailableFeatures) ? plan.unavailableFeatures : [],
    addonServices: Array.isArray(plan.addonServices) ? plan.addonServices : [],
    features: plan.features || {},
    limits: plan.limits || {},
  };
}

async function listPublicPlans() {
  const plans = (await planRepository.listPublicPlans()).filter(
    (plan) => String(plan?.slug || "").toLowerCase() !== "free"
  );
  const free = await getFreePlanConfig();
  const freePlan = {
    _id: "free-plan",
    slug: "free",
    name: free?.name || "Free",
    description: free?.description || "",
    pricing: {
      currency: "INR",
      originalPricePaise: null,
      discountedPricePaise: null,
      gstPercent: 0,
      taxMode: "exclusive",
      billingCycle: "monthly",
    },
    trial: { enabled: false, days: 0 },
    buttonText: free?.buttonText || "Current Plan",
    badgeText: "Free",
    badgeType: "none",
    cardColor: "green",
    icon: "A",
    recommended: false,
    sortOrder: 1,
    publicVisible: true,
    purchasable: false,
    displayFeatures: Array.isArray(free?.displayFeatures) ? free.displayFeatures : [],
    unavailableFeatures: Array.isArray(free?.unavailableFeatures) ? free.unavailableFeatures : [],
    addonServices: Array.isArray(free?.addonServices) ? free.addonServices : [],
    features: free?.features || {},
    limits: free?.limits || {},
  };
  return {
    success: true,
    message: "Plans fetched successfully.",
    data: {
      plans: [mapPlan(freePlan), ...plans.map(mapPlan)],
      note: "WhatsApp/message charges are billed separately from wallet balance where applicable.",
    },
  };
}

module.exports = { listPublicPlans };
