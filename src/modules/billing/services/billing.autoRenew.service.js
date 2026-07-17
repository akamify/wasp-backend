const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { subscriptionRepository, planRepository, processedPaymentEventRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { getRazorpayClient, razorpayKeyId, razorpayKeySecret } = require("@modules/wallet/services/wallet.api.service");
const { createBasicInvoice, writeBillingEvent } = require("@modules/billing/services/billing.lifecycle.service");

const RETRY_DELAYS_MS = String(process.env.SUBSCRIPTION_RETRY_DELAYS_HOURS || "24,48,72")
  .split(",")
  .map((n) => Math.max(1, Number(n || 0)) * 60 * 60 * 1000)
  .filter(Boolean);

function addMonths(date, months) {
  const out = new Date(date);
  out.setMonth(out.getMonth() + Number(months || 1));
  return out;
}

function billingPeriod(plan) {
  const cycle = String(plan?.pricing?.billingCycle || plan?.metadata?.billingCycle || "monthly").toLowerCase();
  if (cycle === "yearly") return "yearly";
  if (cycle === "quarterly") return "monthly";
  return "monthly";
}

function billingInterval(plan) {
  const cycle = String(plan?.pricing?.billingCycle || plan?.metadata?.billingCycle || "monthly").toLowerCase();
  if (cycle === "quarterly") return 3;
  return 1;
}

function planPrice(plan) {
  return calculatePrice({
    originalPricePaise: plan.pricing?.originalPricePaise ?? null,
    discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
    gstPercent: plan.pricing?.gstPercent ?? 18,
    taxMode: plan.pricing?.taxMode || "exclusive",
  });
}

function verifySubscriptionCheckoutSignature({ subscriptionId, paymentId, signature }) {
  if (!razorpayKeySecret) throw new HttpError(400, "Razorpay credentials not configured");
  const expected = crypto.createHmac("sha256", razorpayKeySecret).update(`${paymentId}|${subscriptionId}`).digest("hex");
  const received = String(signature || "");
  if (!received || expected.length !== received.length) throw new HttpError(401, "Invalid subscription signature");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    throw new HttpError(401, "Invalid subscription signature");
  }
}

async function createOrReuseRazorpayPlan(plan) {
  if (plan.razorpayPlanId) return plan.razorpayPlanId;
  const price = planPrice(plan);
  if (!price.payableAmountPaise || price.payableAmountPaise <= 0) throw new HttpError(400, "Free plan cannot use auto renew");
  const client = getRazorpayClient();
  const rpPlan = await client.plans.create({
    period: billingPeriod(plan),
    interval: billingInterval(plan),
    item: {
      name: plan.name,
      amount: price.payableAmountPaise,
      currency: "INR",
      description: plan.description || `${plan.name} subscription`,
    },
    notes: {
      localPlanId: String(plan._id),
      planSlug: plan.slug,
    },
  });
  plan.razorpayPlanId = rpPlan.id;
  await plan.save();
  return rpPlan.id;
}

async function enableAutoRenew(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");

  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!active || active.status !== "active") throw new HttpError(400, "No active paid subscription found");
  const plan = await planRepository.findById(active.planId);
  if (!plan) throw new HttpError(404, "Plan not found");
  const price = planPrice(plan);
  if (!price.payableAmountPaise || price.payableAmountPaise <= 0) throw new HttpError(400, "Free plan does not support auto renew");

  if (active.razorpaySubscriptionId && active.mandateStatus === "active") {
    active.autoRenewEnabled = true;
    active.renewalMethod = "razorpay_subscription";
    active.renewalStatus = "scheduled";
    active.nextBillingAt = active.currentPeriodEnd;
    await active.save();
    return autoRenewSettings(req);
  }

  const razorpayPlanId = await createOrReuseRazorpayPlan(plan);
  let rpSubscription;
  try {
    rpSubscription = await getRazorpayClient().subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: 120,
      quantity: 1,
      customer_notify: 1,
      start_at: Math.max(Math.floor(new Date(active.currentPeriodEnd).getTime() / 1000), Math.floor(Date.now() / 1000) + 300),
      notes: {
        workspaceId: String(workspaceId),
        userId: String(userId),
        localSubscriptionId: String(active._id),
        planId: String(plan._id),
        planSlug: plan.slug,
      },
    });
  } catch (err) {
    const providerMessage = err?.error?.description || err?.response?.data?.error?.description || err?.message || "Failed to create Razorpay subscription";
    throw new HttpError(400, "Auto-renew setup failed", { providerError: providerMessage });
  }

  active.autoRenewEnabled = true;
  active.renewalMethod = "razorpay_subscription";
  active.renewalStatus = "scheduled";
  active.nextBillingAt = active.currentPeriodEnd;
  active.razorpayPlanId = razorpayPlanId;
  active.razorpaySubscriptionId = rpSubscription.id;
  active.providerSubscriptionId = rpSubscription.id;
  active.mandateStatus = "pending";
  active.metadata = { ...(active.metadata || {}), razorpaySubscriptionStatus: rpSubscription.status || "created" };
  await active.save();

  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.auto_renew_setup_started",
    subscriptionId: active._id,
    metadata: { razorpaySubscriptionId: rpSubscription.id, plan: active.planSlug },
  });

  return {
    success: true,
    message: "Auto-renew setup created.",
    data: {
      publicKey: razorpayKeyId,
      razorpaySubscriptionId: rpSubscription.id,
      subscription: serializeAutoRenew(active),
    },
  };
}

async function confirmAutoRenew(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const subscriptionId = String(req.body?.razorpay_subscription_id || req.body?.subscriptionId || "").trim();
  const paymentId = String(req.body?.razorpay_payment_id || req.body?.paymentId || "").trim();
  const signature = String(req.body?.razorpay_signature || req.body?.signature || "").trim();
  if (!subscriptionId || !paymentId || !signature) throw new HttpError(400, "Auto-renew confirmation payload is incomplete");
  verifySubscriptionCheckoutSignature({ subscriptionId, paymentId, signature });

  const active = await subscriptionRepository.findByRazorpaySubscriptionId(subscriptionId);
  if (!active || String(active.workspaceId) !== String(workspaceId)) throw new HttpError(404, "Auto-renew subscription not found");
  active.autoRenewEnabled = true;
  active.renewalMethod = "razorpay_subscription";
  active.renewalStatus = "scheduled";
  active.mandateStatus = "active";
  active.paymentMethodSnapshot = {
    provider: "razorpay",
    type: "mandate",
    label: "Razorpay recurring mandate",
    lastPaymentId: paymentId,
    confirmedAt: new Date(),
  };
  await active.save();
  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.auto_renew_enabled",
    subscriptionId: active._id,
    metadata: { razorpaySubscriptionId: subscriptionId, paymentId },
  });
  return { success: true, message: "Auto-renew enabled.", data: { subscription: serializeAutoRenew(active) } };
}

async function disableAutoRenew(req) {
  const workspaceId = req.workspace?.id;
  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!active) throw new HttpError(400, "No active subscription found");
  if (active.razorpaySubscriptionId) {
    try {
      await getRazorpayClient().subscriptions.cancel(active.razorpaySubscriptionId, false);
    } catch {
      // Local disable should still proceed; webhook/provider may already be cancelled.
    }
  }
  active.autoRenewEnabled = false;
  active.renewalStatus = "disabled";
  active.renewalMethod = "manual";
  active.mandateStatus = active.razorpaySubscriptionId ? "cancelled" : "not_setup";
  active.nextBillingAt = null;
  await active.save();
  await writeBillingEvent({
    req,
    workspaceId,
    userId: req.user?.id,
    action: "billing.auto_renew_disabled",
    subscriptionId: active._id,
    metadata: { plan: active.planSlug },
  });
  return { success: true, message: "Auto-renew disabled.", data: { subscription: serializeAutoRenew(active) } };
}

async function toggleAutoRenew(req) {
  return req.body?.enabled ? enableAutoRenew(req) : disableAutoRenew(req);
}

async function autoRenewSettings(req) {
  const active = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
  return {
    success: true,
    message: "Renewal settings fetched.",
    data: {
      subscription: active ? serializeAutoRenew(active) : null,
      paymentMethod: active?.paymentMethodSnapshot || null,
    },
  };
}

async function handleRazorpaySubscriptionWebhook(event) {
  const eventType = String(event?.event || "");
  const payment = event?.payload?.payment?.entity || null;
  const rpSub = event?.payload?.subscription?.entity || null;
  const subscriptionId = rpSub?.id || payment?.subscription_id || "";
  const webhookEventId = event?.__razorpayEventId || event?.id || "";
  if (!subscriptionId) return { ignored: true };

  let processedEvent = null;
  try {
    const claimed = await processedPaymentEventRepository.claimEvent({
      provider: "razorpay",
      eventId: webhookEventId || `${eventType}_${subscriptionId}_${payment?.id || Date.now()}`,
      eventType,
      paymentId: payment?.id || "",
      orderId: payment?.order_id || "",
      subscriptionId,
    });
    if (claimed.duplicate) return { duplicate: true };
    processedEvent = claimed.event;
  } catch (err) {
    if (String(err?.code) === "11000") return { duplicate: true };
    throw err;
  }

  try {
    const sub = await subscriptionRepository.findByRazorpaySubscriptionId(subscriptionId);
    if (!sub) {
      const result = { ignored: true, reason: "local_subscription_not_found" };
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id, { status: "ignored" });
      return result;
    }
    const now = new Date();
    const workspaceId = sub.workspaceId;
    const userId = sub.userId;

    if (["subscription.activated", "subscription.authenticated"].includes(eventType)) {
      sub.mandateStatus = "active";
      sub.autoRenewEnabled = true;
      sub.renewalMethod = "razorpay_subscription";
      sub.renewalStatus = "scheduled";
      sub.metadata = { ...(sub.metadata || {}), razorpaySubscriptionStatus: rpSub?.status || "active" };
      await sub.save();
      await writeBillingEvent({ workspaceId, userId, action: "billing.mandate_activated", subscriptionId: sub._id, dedupeKey: webhookEventId ? `billing:${webhookEventId}:mandate` : "", metadata: { razorpaySubscriptionId: subscriptionId } });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return { success: true };
    }

    if (["subscription.charged", "payment.captured"].includes(eventType)) {
      const plan = await planRepository.findById(sub.planId);
      const previousEnd = sub.currentPeriodEnd || now;
      const nextEnd = addMonths(previousEnd > now ? previousEnd : now, sub.durationMonths || 1);
      sub.status = "active";
      sub.renewalStatus = "renewed";
      sub.renewalAttempts = 0;
      sub.lastRenewalAttemptAt = now;
      sub.nextRenewalAttemptAt = null;
      sub.lastRenewalAt = now;
      sub.nextBillingAt = nextEnd;
      sub.currentPeriodStart = previousEnd > now ? previousEnd : now;
      sub.currentPeriodEnd = nextEnd;
      sub.validUntil = nextEnd;
      sub.paymentMethodSnapshot = {
        ...(sub.paymentMethodSnapshot || {}),
        provider: "razorpay",
        type: "mandate",
        lastPaymentId: payment?.id || "",
        lastChargedAt: now,
      };
      await sub.save();
      if (plan) {
        await createBasicInvoice({
          workspaceId,
          userId,
          subscription: sub,
          plan,
          status: "paid",
          paymentStatus: "paid",
          renewalType: "renewal",
          payment: {
            provider: "razorpay",
            providerPaymentId: payment?.id || "",
            providerSubscriptionId: subscriptionId,
            amountPaise: Number(payment?.amount || 0),
            status: payment?.status || "captured",
            recurring: true,
            paidAt: now,
          },
          createdBy: userId,
        }).catch(() => null);
      }
      await writeBillingEvent({
        workspaceId,
        userId,
        action: "billing.subscription_renewed",
        subscriptionId: sub._id,
        dedupeKey: webhookEventId ? `billing:${webhookEventId}:renewed` : "",
        metadata: { razorpaySubscriptionId: subscriptionId, paymentId: payment?.id || "", nextBillingAt: nextEnd },
      });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return { success: true };
    }

    if (["payment.failed", "subscription.pending", "subscription.halted"].includes(eventType)) {
      const attempts = Number(sub.renewalAttempts || 0) + 1;
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] || null;
      sub.renewalAttempts = attempts;
      sub.lastRenewalAttemptAt = now;
      sub.renewalStatus = delay ? "retry_scheduled" : "payment_failed";
      sub.nextRenewalAttemptAt = delay ? new Date(now.getTime() + delay) : null;
      sub.mandateStatus = eventType === "subscription.halted" ? "failed" : sub.mandateStatus || "active";
      await sub.save();
      await writeBillingEvent({
        workspaceId,
        userId,
        action: "billing.auto_charge_failed",
        subscriptionId: sub._id,
        dedupeKey: webhookEventId ? `billing:${webhookEventId}:failed` : "",
        metadata: { eventType, attempts, nextRetryAt: sub.nextRenewalAttemptAt, paymentId: payment?.id || "" },
      });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return { success: true };
    }

    if (["subscription.cancelled", "subscription.completed"].includes(eventType)) {
      sub.autoRenewEnabled = false;
      sub.renewalStatus = "disabled";
      sub.mandateStatus = eventType === "subscription.cancelled" ? "cancelled" : sub.mandateStatus;
      await sub.save();
      await writeBillingEvent({ workspaceId, userId, action: "billing.auto_renew_provider_stopped", subscriptionId: sub._id, dedupeKey: webhookEventId ? `billing:${webhookEventId}:stopped` : "", metadata: { eventType } });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return { success: true };
    }

    if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id, { status: "ignored" });
    return { ignored: true, eventType };
  } catch (err) {
    if (processedEvent?._id) await processedPaymentEventRepository.markFailed(processedEvent._id, err?.message || err);
    throw err;
  }
}

async function processAutoRenewReminders({ now = new Date(), limit = 100 } = {}) {
  const rows = await subscriptionRepository.listAutoRenewDue(now, { limit });
  let processed = 0;
  for (const sub of rows) {
    if (!sub.razorpaySubscriptionId || sub.mandateStatus !== "active") continue;
    const lastReminder = sub.metadata?.lastRenewalReminderAt ? new Date(sub.metadata.lastRenewalReminderAt) : null;
    if (lastReminder && now.getTime() - lastReminder.getTime() < 23 * 60 * 60 * 1000) continue;
    if (!sub.nextBillingAt) sub.nextBillingAt = sub.currentPeriodEnd;
    if (!sub.renewalStatus || sub.renewalStatus === "none") sub.renewalStatus = "scheduled";
    sub.metadata = { ...(sub.metadata || {}), lastRenewalReminderAt: now };
    await sub.save();
    await writeBillingEvent({
      workspaceId: sub.workspaceId,
      userId: sub.userId,
      action: "billing.renewal_reminder",
      subscriptionId: sub._id,
      metadata: { nextBillingAt: sub.nextBillingAt, plan: sub.planSlug },
    });
    processed += 1;
  }
  return { processed };
}

function serializeAutoRenew(sub) {
  return {
    id: String(sub._id),
    planSlug: sub.planSlug,
    planName: sub.planName,
    status: sub.status,
    autoRenewEnabled: Boolean(sub.autoRenewEnabled),
    renewalMethod: sub.renewalMethod || "",
    renewalStatus: sub.renewalStatus || "",
    renewalAttempts: Number(sub.renewalAttempts || 0),
    nextRenewalDate: sub.nextBillingAt || sub.currentPeriodEnd || null,
    lastRenewalDate: sub.lastRenewalAt || null,
    lastRenewalAttemptAt: sub.lastRenewalAttemptAt || null,
    nextRenewalAttemptAt: sub.nextRenewalAttemptAt || null,
    mandateStatus: sub.mandateStatus || "not_setup",
    razorpaySubscriptionId: sub.razorpaySubscriptionId || "",
    paymentMethod: sub.paymentMethodSnapshot || null,
  };
}

module.exports = {
  enableAutoRenew,
  confirmAutoRenew,
  disableAutoRenew,
  toggleAutoRenew,
  autoRenewSettings,
  handleRazorpaySubscriptionWebhook,
  processAutoRenewReminders,
};
