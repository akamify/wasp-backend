const { planRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");

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
  const plans = await planRepository.listPublicPlans();
  return {
    success: true,
    message: "Plans fetched successfully.",
    data: {
      plans: plans.map(mapPlan),
      note: "WhatsApp/message charges are billed separately from wallet balance where applicable.",
    },
  };
}

module.exports = { listPublicPlans };
