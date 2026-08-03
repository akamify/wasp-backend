const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { subscriptionRepository, planRepository, processedPaymentEventRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { getRazorpayClient, razorpayKeyId, razorpayKeySecret } = require("@modules/wallet/services/wallet.api.service");
const { createBasicInvoice, writeBillingEvent } = require("@modules/billing/services/billing.lifecycle.service");
const { createRazorpaySubscriptionWithPlanRetry, activateSubscriptionPurchaseFromWebhook } = require("@modules/billing/services/billing.checkout.service");

const RETRY_DELAYS_MS = String(process.env.SUBSCRIPTION_RETRY_DELAYS_HOURS || "24,48,72")
  .split(",")
  .map((n) => Math.max(1, Number(n || 0)) * 60 * 60 * 1000)
  .filter(Boolean);

function addMonths(date, months) {
  const out = new Date(date);
  out.setMonth(out.getMonth() + Number(months || 1));
  return out;
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

function clearPendingMandateSetup(metadata = {}) {
  const next = { ...(metadata || {}) };
  delete next.pendingMandateSetup;
  return next;
}

async function cancelProviderSubscription(razorpaySubscriptionId) {
  if (!razorpaySubscriptionId) return;
  try {
    await getRazorpayClient().subscriptions.cancel(razorpaySubscriptionId, false);
  } catch {
    // Best effort only.
  }
}

async function createMandateSetup(req, { replaceExisting = false } = {}) {
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

  if (!replaceExisting && active.autoRenewEnabled && active.mandateStatus === "active" && active.razorpaySubscriptionId) {
    return autoRenewSettings(req);
  }

  let razorpayPlanId = "";
  let rpSubscription;
  try {
    const created = await createRazorpaySubscriptionWithPlanRetry(plan, {
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
        replaceExisting: replaceExisting ? "1" : "0",
      },
    });
    rpSubscription = created.subscription;
    razorpayPlanId = created.razorpayPlanId;
  } catch (err) {
    const providerMessage =
      err?.details?.providerError ||
      err?.response?.data?.details?.providerError ||
      err?.error?.description ||
      err?.response?.data?.error?.description ||
      err?.message ||
      "Failed to create Razorpay subscription";
    throw new HttpError(400, "Auto-renew setup failed", { providerError: providerMessage });
  }

  active.razorpayPlanId = razorpayPlanId;
  active.nextBillingAt = active.currentPeriodEnd;
  active.renewalMethod = "razorpay_subscription";
  active.renewalStatus = active.autoRenewEnabled && active.mandateStatus === "active" ? "scheduled" : "processing";
  if (!active.autoRenewEnabled || active.mandateStatus !== "active") {
    active.mandateStatus = "pending";
  }
  active.metadata = {
    ...(active.metadata || {}),
    pendingMandateSetup: {
      razorpaySubscriptionId: rpSubscription.id,
      razorpayPlanId,
      createdAt: new Date(),
      replaceExisting: Boolean(replaceExisting),
      previousRazorpaySubscriptionId: active.razorpaySubscriptionId || "",
      previousProviderSubscriptionId: active.providerSubscriptionId || "",
      previousPaymentMethodSnapshot: active.paymentMethodSnapshot || null,
      providerStatus: rpSubscription.status || "created",
    },
    razorpaySubscriptionStatus: rpSubscription.status || "created",
  };
  await active.save();

  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: replaceExisting ? "billing.auto_renew_payment_method_change_started" : "billing.auto_renew_setup_started",
    subscriptionId: active._id,
    metadata: { razorpaySubscriptionId: rpSubscription.id, plan: active.planSlug, replaceExisting },
  });

  return {
    success: true,
    message: replaceExisting ? "Payment method change started." : "Auto-renew setup created.",
    data: {
      publicKey: razorpayKeyId,
      razorpaySubscriptionId: rpSubscription.id,
      checkoutKind: "subscription_mandate",
      subscription: serializeAutoRenew(active),
    },
  };
}

async function finalizeMandateSetup({ sub, subscriptionId, paymentId = "", source = "confirm", req = null, webhookEventId = "" }) {
  const pending = sub.metadata?.pendingMandateSetup || null;
  const now = new Date();
  const previousSubscriptionId =
    pending?.replaceExisting && pending?.previousRazorpaySubscriptionId && pending.previousRazorpaySubscriptionId !== subscriptionId
      ? pending.previousRazorpaySubscriptionId
      : "";

  sub.autoRenewEnabled = true;
  sub.renewalMethod = "razorpay_subscription";
  sub.renewalStatus = "scheduled";
  sub.mandateStatus = "active";
  sub.nextBillingAt = sub.currentPeriodEnd;
  sub.razorpaySubscriptionId = subscriptionId;
  sub.providerSubscriptionId = subscriptionId;
  if (pending?.razorpayPlanId) sub.razorpayPlanId = pending.razorpayPlanId;
  sub.paymentMethodSnapshot = {
    provider: "razorpay",
    type: "mandate",
    label: "Razorpay recurring mandate",
    lastPaymentId: paymentId,
    confirmedAt: now,
  };
  sub.metadata = {
    ...clearPendingMandateSetup(sub.metadata || {}),
    razorpaySubscriptionStatus: "active",
    lastMandateActivationSource: source,
    lastMandateActivationEventId: webhookEventId || "",
  };
  await sub.save();

  if (previousSubscriptionId) {
    await cancelProviderSubscription(previousSubscriptionId);
  }

  await writeBillingEvent({
    req,
    workspaceId: sub.workspaceId,
    userId: sub.userId,
    action: pending?.replaceExisting ? "billing.auto_renew_payment_method_changed" : "billing.auto_renew_enabled",
    subscriptionId: sub._id,
    metadata: { razorpaySubscriptionId: subscriptionId, paymentId, source },
  });

  return { success: true, message: pending?.replaceExisting ? "Payment method updated." : "Auto-renew enabled.", data: { subscription: serializeAutoRenew(sub) } };
}

async function enableAutoRenew(req) {
  return createMandateSetup(req, { replaceExisting: false });
}

async function changePaymentMethod(req) {
  return createMandateSetup(req, { replaceExisting: true });
}

async function confirmAutoRenew(req) {
  const workspaceId = req.workspace?.id;
  const subscriptionId = String(req.body?.razorpay_subscription_id || req.body?.subscriptionId || "").trim();
  const paymentId = String(req.body?.razorpay_payment_id || req.body?.paymentId || "").trim();
  const signature = String(req.body?.razorpay_signature || req.body?.signature || "").trim();
  if (!subscriptionId || !paymentId || !signature) throw new HttpError(400, "Auto-renew confirmation payload is incomplete");
  verifySubscriptionCheckoutSignature({ subscriptionId, paymentId, signature });

  let active = await subscriptionRepository.findByPendingMandateSetupSubscriptionId(subscriptionId);
  if (!active) active = await subscriptionRepository.findByRazorpaySubscriptionId(subscriptionId);
  if (!active || String(active.workspaceId) !== String(workspaceId)) throw new HttpError(404, "Auto-renew subscription not found");

  return finalizeMandateSetup({ sub: active, subscriptionId, paymentId, source: "confirm", req });
}

async function disableAutoRenew(req) {
  const workspaceId = req.workspace?.id;
  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!active) throw new HttpError(400, "No active subscription found");

  const pendingSubscriptionId = active.metadata?.pendingMandateSetup?.razorpaySubscriptionId || "";
  if (pendingSubscriptionId && pendingSubscriptionId !== active.razorpaySubscriptionId) {
    await cancelProviderSubscription(pendingSubscriptionId);
  }
  if (active.razorpaySubscriptionId) {
    await cancelProviderSubscription(active.razorpaySubscriptionId);
  }

  active.autoRenewEnabled = false;
  active.renewalStatus = "disabled";
  active.renewalMethod = "manual";
  active.mandateStatus = active.razorpaySubscriptionId || pendingSubscriptionId ? "cancelled" : "not_setup";
  active.nextBillingAt = null;
  active.metadata = clearPendingMandateSetup(active.metadata || {});
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
    let sub = await subscriptionRepository.findByRazorpaySubscriptionId(subscriptionId);
    let pendingMandateSub = null;
    if (!sub) pendingMandateSub = await subscriptionRepository.findByPendingMandateSetupSubscriptionId(subscriptionId);

    if (!sub && !pendingMandateSub) {
      const purchaseResult = await activateSubscriptionPurchaseFromWebhook({
        eventType,
        payment,
        subscriptionEntity: rpSub,
        webhookEventId,
      });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id, { status: purchaseResult?.ignored ? "ignored" : "processed" });
      return purchaseResult;
    }

    if (pendingMandateSub && ["subscription.activated", "subscription.authenticated", "payment.captured"].includes(eventType)) {
      const result = await finalizeMandateSetup({
        sub: pendingMandateSub,
        subscriptionId,
        paymentId: payment?.id || "",
        source: "webhook",
        webhookEventId,
      });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return result;
    }

    if (pendingMandateSub && ["payment.failed", "subscription.pending", "subscription.halted", "subscription.cancelled"].includes(eventType)) {
      pendingMandateSub.metadata = {
        ...(pendingMandateSub.metadata || {}),
        pendingMandateSetup: {
          ...(pendingMandateSub.metadata?.pendingMandateSetup || {}),
          providerStatus: rpSub?.status || eventType,
          failedAt: new Date(),
        },
      };
      if (!pendingMandateSub.autoRenewEnabled) {
        pendingMandateSub.mandateStatus = eventType === "subscription.cancelled" ? "cancelled" : "failed";
        pendingMandateSub.renewalStatus = "manual_due";
      }
      await pendingMandateSub.save();
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return { success: true };
    }

    sub = sub || pendingMandateSub;
    if (!sub) {
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id, { status: "ignored" });
      return { ignored: true, reason: "local_subscription_not_found" };
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
      await writeBillingEvent({
        workspaceId,
        userId,
        action: "billing.mandate_activated",
        subscriptionId: sub._id,
        dedupeKey: webhookEventId ? `billing:${webhookEventId}:mandate` : "",
        metadata: { razorpaySubscriptionId: subscriptionId },
      });
      if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id);
      return { success: true };
    }

    if (["subscription.charged", "payment.captured"].includes(eventType)) {
      if (payment?.id && sub.metadata?.initialMandatePaymentId && String(sub.metadata.initialMandatePaymentId) === String(payment.id) && !sub.lastRenewalAt) {
        if (processedEvent?._id) await processedPaymentEventRepository.markProcessed(processedEvent._id, { status: "ignored" });
        return { ignored: true, reason: "initial_purchase_payment" };
      }
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
      sub.renewalMethod = "manual";
      sub.mandateStatus = eventType === "subscription.cancelled" ? "cancelled" : sub.mandateStatus;
      sub.metadata = clearPendingMandateSetup(sub.metadata || {});
      await sub.save();
      await writeBillingEvent({
        workspaceId,
        userId,
        action: "billing.auto_renew_provider_stopped",
        subscriptionId: sub._id,
        dedupeKey: webhookEventId ? `billing:${webhookEventId}:stopped` : "",
        metadata: { eventType },
      });
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
  const pendingMandateSetup = sub.metadata?.pendingMandateSetup || null;
  const autoRenewEligible = sub.planSlug !== "free" && ["active", "past_due", "grace_period"].includes(String(sub.status || ""));
  const fallbackMode = pendingMandateSetup ? "pending_mandate" : sub.autoRenewEnabled ? "none" : autoRenewEligible ? "manual_renew" : "";
  return {
    id: String(sub._id),
    planSlug: sub.planSlug,
    planName: sub.planName,
    status: sub.status,
    autoRenewEligible,
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
    fallbackMode,
    pendingMandateSetup: pendingMandateSetup
      ? {
          razorpaySubscriptionId: pendingMandateSetup.razorpaySubscriptionId || "",
          replaceExisting: Boolean(pendingMandateSetup.replaceExisting),
          createdAt: pendingMandateSetup.createdAt || null,
          providerStatus: pendingMandateSetup.providerStatus || "",
        }
      : null,
  };
}

module.exports = {
  enableAutoRenew,
  confirmAutoRenew,
  changePaymentMethod,
  disableAutoRenew,
  toggleAutoRenew,
  autoRenewSettings,
  handleRazorpaySubscriptionWebhook,
  processAutoRenewReminders,
};
