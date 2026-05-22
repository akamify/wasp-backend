function mapPlanSummaryItem(i) {
  return { plan: i._id || "unknown", count: i.count };
}

function mapWorkspaceSubscriptionItem(workspace, owner, subscription) {
  const price = subscription?.snapshot?.price || {};
  const gst = subscription?.snapshot?.gst || {};
  const payableAmountPaise = price.payableAmountPaise == null ? null : Number(price.payableAmountPaise);
  const discountedPricePaise = price.discountedPricePaise == null ? null : Number(price.discountedPricePaise);
  const gstAmountPaise = gst.gstAmountPaise == null ? null : Number(gst.gstAmountPaise);

  return {
    id: String(workspace._id),
    name: workspace.name,
    plan: workspace.plan,
    isActive: workspace.isActive,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
    subscription: subscription
      ? {
          id: String(subscription._id),
          planName: subscription.planName || null,
          planSlug: subscription.planSlug || null,
          subscriptionStatus: subscription.status || null,
          purchasedAt: subscription.createdAt || null,
          validFrom: subscription.currentPeriodStart || null,
          validUntil: subscription.currentPeriodEnd || null,
          durationMonths: subscription.durationMonths == null ? null : Number(subscription.durationMonths),
          autoRenewEnabled: Boolean(subscription.autoRenewEnabled),
          paymentStatus: subscription.status || null,
          amountPaidPaise: discountedPricePaise,
          gstAmountPaise,
          payableAmountPaise,
          paymentMode: subscription.paymentMode || null,
          features: subscription?.snapshot?.features || {},
          limits: subscription?.snapshot?.limits || {},
        }
      : {
          id: null,
          planName: null,
          planSlug: null,
          subscriptionStatus: null,
          purchasedAt: null,
          validFrom: null,
          validUntil: null,
          durationMonths: null,
          autoRenewEnabled: null,
          paymentStatus: null,
          amountPaidPaise: null,
          gstAmountPaise: null,
          payableAmountPaise: null,
          paymentMode: null,
          features: {},
          limits: {},
        },
  };
}

module.exports = { mapPlanSummaryItem, mapWorkspaceSubscriptionItem };
