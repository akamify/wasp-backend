const crypto = require("crypto");
const mongoose = require("mongoose");
const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");
const { planRepository, subscriptionRepository, checkoutIntentRepository } = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { hashIdempotencyParts } = require("@modules/billing/utils/idempotency");
const { getRazorpayClient, razorpayKeyId, razorpayKeySecret } = require("@modules/wallet/services/wallet.api.service");
const { createBasicInvoice, writeBillingEvent, activateRenewalPayment } = require("@modules/billing/services/billing.lifecycle.service");

function addMonths(date, months) {
  const out = new Date(date);
  out.setMonth(out.getMonth() + Number(months || 1));
  return out;
}

function buildReceipt(workspaceId, prefix = "sub") {
  const ws = String(workspaceId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-10) || "ws";
  return `${prefix}_${ws}_${Date.now().toString(36)}`.slice(0, 40);
}

function mapPlanPrice(plan) {
  return calculatePrice({
    originalPricePaise: plan.pricing?.originalPricePaise ?? null,
    discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
    gstPercent: plan.pricing?.gstPercent ?? 18,
    taxMode: plan.pricing?.taxMode || "exclusive",
  });
}

function assertPurchasablePlan(plan) {
  if (!plan) throw new HttpError(404, "Plan not found");
  if (plan.deletedAt) throw new HttpError(404, "Plan not found");
  if (plan.status !== "published") throw new HttpError(400, "Plan is not published");
  if (!plan.publicVisible || !plan.purchasable) throw new HttpError(400, "Plan is not purchasable");
}

function buildSnapshot(plan, price) {
  return {
    price: {
      originalPricePaise: price.originalPricePaise,
      discountedPricePaise: price.discountedPricePaise,
      discountAmountPaise: price.discountAmountPaise,
      discountPercent: price.discountPercent,
      payableAmountPaise: price.payableAmountPaise,
    },
    gst: {
      gstPercent: price.gstPercent,
      gstAmountPaise: price.gstAmountPaise,
      taxMode: price.taxMode,
    },
    features: plan.features || {},
    limits: plan.limits || {},
    displayFeatures: plan.displayFeatures || [],
    unavailableFeatures: plan.unavailableFeatures || [],
    addonServices: plan.addonServices || [],
  };
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

function buildRazorpayPlanConfig(plan) {
  const price = mapPlanPrice(plan);
  if (!price.payableAmountPaise || price.payableAmountPaise <= 0) {
    throw new HttpError(400, "Free plan cannot use auto renew");
  }
  return {
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
  };
}

function buildRazorpayPlanConfigHash(plan) {
  const config = buildRazorpayPlanConfig(plan);
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function extractProviderMessage(err, fallback = "Provider request failed") {
  return (
    err?.error?.description ||
    err?.response?.data?.error?.description ||
    err?.response?.data?.error?.reason ||
    err?.message ||
    fallback
  );
}

function isInvalidProviderPlanReference(message = "") {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("the id provided is invalid or could not be found") ||
    normalized.includes("id provided is invalid") ||
    normalized.includes("could not be found") ||
    normalized.includes("plan id provided does not exist") ||
    normalized.includes("no such plan")
  );
}

function verifyRazorpayOrderSignature({ orderId, paymentId, signature }) {
  if (!razorpayKeySecret) throw new HttpError(400, "Razorpay credentials not configured");
  const expected = crypto.createHmac("sha256", razorpayKeySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const received = String(signature || "");
  if (!received || expected.length !== received.length) throw new HttpError(401, "Invalid payment signature");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    throw new HttpError(401, "Invalid payment signature");
  }
}

function verifyRazorpaySubscriptionSignature({ subscriptionId, paymentId, signature }) {
  if (!razorpayKeySecret) throw new HttpError(400, "Razorpay credentials not configured");
  const expected = crypto.createHmac("sha256", razorpayKeySecret).update(`${paymentId}|${subscriptionId}`).digest("hex");
  const received = String(signature || "");
  if (!received || expected.length !== received.length) throw new HttpError(401, "Invalid payment signature");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    throw new HttpError(401, "Invalid payment signature");
  }
}

function serializeActivatedSubscription(subscription, purchaseState) {
  return {
    id: String(subscription._id),
    planSlug: subscription.planSlug,
    planName: subscription.planName,
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    autoRenewEnabled: Boolean(subscription.autoRenewEnabled),
    mandateStatus: subscription.mandateStatus || "not_setup",
    renewalMethod: subscription.renewalMethod || "",
    nextBillingAt: subscription.nextBillingAt || null,
    fallbackMode: subscription.autoRenewEnabled ? "none" : "manual_renew",
    purchaseState,
    features: subscription.snapshot?.features || {},
    limits: subscription.snapshot?.limits || {},
  };
}

async function fetchWorkspaceForPurchase({ workspaceId, userId, workspaceAccessRole }) {
  const workspace = await Workspace.findById(workspaceId).select("ownerId ownerUserId name plan isActive status");
  if (!workspace || !workspace.isActive || workspace.status === "deleted") throw new HttpError(404, "Workspace not found");
  const isOwner = String(workspace.ownerUserId || workspace.ownerId) === String(userId);
  if (!isOwner && workspaceAccessRole !== "owner") throw new HttpError(403, "Only workspace owner can purchase a subscription");
  return workspace;
}

async function createOrReuseRazorpayPlan(plan) {
  const configHash = buildRazorpayPlanConfigHash(plan);
  if (plan.razorpayPlanId && plan.razorpayPlanConfigHash === configHash) {
    return plan.razorpayPlanId;
  }

  const config = buildRazorpayPlanConfig(plan);
  const client = getRazorpayClient();
  const rpPlan = await client.plans.create(config);
  plan.razorpayPlanId = rpPlan.id;
  plan.razorpayPlanConfigHash = configHash;
  plan.razorpayPlanSyncedAt = new Date();
  await plan.save();
  return rpPlan.id;
}

async function invalidateRazorpayPlanSync(plan) {
  plan.razorpayPlanId = "";
  plan.razorpayPlanConfigHash = "";
  plan.razorpayPlanSyncedAt = null;
  await plan.save();
}

async function createRazorpaySubscriptionWithPlanRetry(plan, payload) {
  let razorpayPlanId = await createOrReuseRazorpayPlan(plan);
  try {
    const subscription = await getRazorpayClient().subscriptions.create({
      ...payload,
      plan_id: razorpayPlanId,
    });
    return { subscription, razorpayPlanId, retriedWithFreshPlan: false };
  } catch (err) {
    const providerMessage = extractProviderMessage(err, "Failed to create Razorpay subscription");
    if (!plan.razorpayPlanId || !isInvalidProviderPlanReference(providerMessage)) {
      throw new HttpError(400, "Subscription mandate checkout creation failed", { providerError: providerMessage });
    }

    await invalidateRazorpayPlanSync(plan);
    razorpayPlanId = await createOrReuseRazorpayPlan(plan);

    try {
      const subscription = await getRazorpayClient().subscriptions.create({
        ...payload,
        plan_id: razorpayPlanId,
      });
      return { subscription, razorpayPlanId, retriedWithFreshPlan: true };
    } catch (retryErr) {
      const retryProviderMessage = extractProviderMessage(retryErr, "Failed to create Razorpay subscription");
      throw new HttpError(400, "Subscription mandate checkout creation failed", { providerError: retryProviderMessage });
    }
  }
}

async function activateSubscriptionPurchaseFromIntent({
  req = null,
  intent,
  payment,
  plan,
  orderId = "",
  paymentId = "",
  subscriptionId = "",
  autoRenewEnabled,
  mandateStatus,
  renewalMethod,
  paymentMode,
  purchaseState,
  providerStatus = "",
  paymentMethodSnapshot = null,
  metadata = {},
}) {
  const workspaceId = intent.workspaceId;
  const userId = intent.userId;
  const now = new Date();
  const currentPeriodEnd = addMonths(now, intent.durationMonths);
  const price = mapPlanPrice(plan);
  const snapshot = buildSnapshot(plan, price);
  let created = null;
  let previousPlanSlug = "free";
  let updatedWorkspace = null;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const workspace = await Workspace.findById(workspaceId).session(session);
      if (!workspace || !workspace.isActive || workspace.status === "deleted") throw new HttpError(404, "Workspace not found");

      const active = await subscriptionRepository.findActiveByWorkspace(workspaceId, { session });
      if (active) {
        previousPlanSlug = active.planSlug;
        active.$session(session);
        active.status = "cancelled";
        active.cancelledAt = now;
        active.cancelAtPeriodEnd = false;
        active.metadata = {
          ...(active.metadata || {}),
          replacedByCheckoutIntentId: String(intent._id),
          replacementReason: "user_upgrade",
        };
      }

      await subscriptionRepository.cancelActiveByWorkspace(
        workspaceId,
        {
          status: "cancelled",
          cancelledAt: now,
          metadata: {
            bulkReplacementReason: "user_upgrade",
            replacedByCheckoutIntentId: String(intent._id),
          },
        },
        { session }
      );

      created = await subscriptionRepository.createSubscription(
        {
          workspaceId,
          userId,
          planId: plan._id,
          planSlug: plan.slug,
          planName: plan.name,
          planType: plan.planType || "custom",
          status: "active",
          currentPeriodStart: now,
          currentPeriodEnd,
          startedAt: now,
          purchasedAt: now,
          validUntil: currentPeriodEnd,
          durationMonths: intent.durationMonths,
          autoRenewEnabled: Boolean(autoRenewEnabled),
          cancelAtPeriodEnd: false,
          latestCheckoutIntentId: intent._id,
          snapshot,
          paymentMode,
          nextBillingAt: autoRenewEnabled ? currentPeriodEnd : null,
          renewalMethod: renewalMethod || "",
          renewalStatus: autoRenewEnabled ? "scheduled" : "manual_due",
          mandateStatus: mandateStatus || "not_setup",
          razorpaySubscriptionId: subscriptionId || "",
          providerSubscriptionId: subscriptionId || "",
          paymentMethodSnapshot: paymentMethodSnapshot || {},
          metadata: {
            source: autoRenewEnabled ? "user_checkout_autopay" : "user_checkout_manual_fallback",
            razorpayOrderId: orderId,
            razorpayPaymentId: paymentId,
            providerStatus,
            initialMandatePaymentId: autoRenewEnabled ? paymentId : "",
            previousSubscriptionId: active ? String(active._id) : null,
            ...metadata,
          },
        },
        { session }
      );

      if (active) {
        active.replacedBySubscriptionId = created._id;
        await active.save({ session });
      }

      await checkoutIntentRepository.markPaid(
        intent._id,
        {
          razorpayOrderId: orderId || intent.razorpayOrderId || "",
          razorpaySubscriptionId: subscriptionId || intent.razorpaySubscriptionId || "",
          razorpayPaymentId: paymentId || intent.razorpayPaymentId || "",
          providerStatus,
          fallbackUsed: !autoRenewEnabled,
          purchaseResultState: purchaseState,
        },
        { session }
      );

      await createBasicInvoice({
        workspaceId,
        userId,
        subscription: created,
        plan,
        payment: {
          provider: "razorpay",
          providerOrderId: orderId || "",
          providerPaymentId: paymentId || "",
          providerSubscriptionId: subscriptionId || "",
          amountPaise: Number(payment?.amount || price.payableAmountPaise || 0),
          status: payment?.status || providerStatus || (autoRenewEnabled ? "authenticated" : "captured"),
          recurring: Boolean(autoRenewEnabled),
        },
        createdBy: userId,
        session,
      });

      workspace.plan = plan.slug;
      workspace.crmEnabled = Boolean(plan.features?.crmPageAccess || plan.features?.crmAccess);
      workspace.features = workspace.features || {};
      workspace.features.externalChatApiAccess = Boolean(plan.features?.externalChatApiAccess);
      workspace.allowedApiPermissions = workspace.allowedApiPermissions || {};
      workspace.allowedApiPermissions.chatAccess = Boolean(plan.features?.externalChatApiAccess);
      await workspace.save({ session });
      updatedWorkspace = workspace;
    });
  } catch (err) {
    await checkoutIntentRepository.markPaymentPending(intent._id, {
      activationError: err?.message || "activation_failed",
      providerStatus,
      purchaseResultState: autoRenewEnabled ? "mandate_pending" : "purchase_failed",
    });
    throw err;
  } finally {
    await session.endSession();
  }

  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: previousPlanSlug !== "free" ? "billing.subscription_upgraded" : "billing.subscription_purchased",
    subscriptionId: created._id,
    dedupeKey: paymentId ? `billing:payment:${paymentId}:activated` : subscriptionId ? `billing:subscription:${subscriptionId}:activated` : "",
    metadata: {
      fromPlan: previousPlanSlug,
      toPlan: plan.slug,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySubscriptionId: subscriptionId,
      purchaseState,
    },
  });

  return {
    success: true,
    message: autoRenewEnabled
      ? "Subscription activated with auto renew."
      : "Subscription activated without auto renew.",
    data: {
      purchaseState,
      subscription: serializeActivatedSubscription(created, purchaseState),
      workspace: {
        id: updatedWorkspace ? String(updatedWorkspace._id) : String(workspaceId),
        plan: updatedWorkspace?.plan || plan.slug,
      },
    },
  };
}

async function createAutopayCheckout({ workspaceId, userId, plan, durationMonths, fallbackAllowed }) {
  const price = mapPlanPrice(plan);
  const snapshot = buildSnapshot(plan, price);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  let razorpayPlanId = "";

  let rpSubscription;
  try {
    const created = await createRazorpaySubscriptionWithPlanRetry(plan, {
      total_count: 120,
      quantity: 1,
      customer_notify: 1,
      expire_by: Math.floor(expiresAt.getTime() / 1000),
      notes: {
        purpose: "subscription_purchase",
        workspaceId: String(workspaceId),
        userId: String(userId),
        planId: String(plan._id),
        planSlug: plan.slug,
      },
    });
    rpSubscription = created.subscription;
    razorpayPlanId = created.razorpayPlanId;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const providerMessage = extractProviderMessage(err, "Failed to create Razorpay subscription");
    throw new HttpError(400, "Subscription mandate checkout creation failed", { providerError: providerMessage });
  }

  const intent = await checkoutIntentRepository.createIntent({
    workspaceId,
    userId,
    planId: plan._id,
    planSlug: plan.slug,
    durationMonths,
    mode: "autopay",
    checkoutMode: "subscription_mandate",
    purpose: "subscription",
    recurringIntent: true,
    fallbackAllowed: Boolean(fallbackAllowed),
    status: "payment_pending",
    purchaseResultState: "mandate_pending",
    providerStatus: rpSubscription.status || "created",
    amountSnapshot: snapshot.price,
    gstSnapshot: snapshot.gst,
    featuresSnapshot: snapshot.features,
    limitsSnapshot: snapshot.limits,
    razorpaySubscriptionId: rpSubscription.id,
    idempotencyKey: hashIdempotencyParts(["subscription-checkout-autopay", workspaceId, userId, plan._id, rpSubscription.id]),
    expiresAt,
    metadata: {
      recurringIntent: true,
      fallbackAllowed: Boolean(fallbackAllowed),
      providerShortUrl: rpSubscription.short_url || "",
    },
  });

  return {
    success: true,
    message: "Subscription mandate checkout created.",
    data: {
      checkoutIntentId: String(intent._id),
      checkoutKind: "subscription_mandate",
      purchaseState: "mandate_pending",
      fallbackAllowed: Boolean(fallbackAllowed),
      publicKey: razorpayKeyId,
      razorpaySubscriptionId: rpSubscription.id,
      expiresAt,
      plan: {
        id: String(plan._id),
        slug: plan.slug,
        name: plan.name,
        pricing: snapshot.price,
        gst: snapshot.gst,
      },
    },
  };
}

async function createOneTimeCheckout({ workspaceId, userId, plan, durationMonths, fallbackAllowed }) {
  const price = mapPlanPrice(plan);
  let order;
  try {
    const client = getRazorpayClient();
    order = await client.orders.create({
      amount: price.payableAmountPaise,
      currency: "INR",
      receipt: buildReceipt(workspaceId),
      notes: {
        purpose: "subscription",
        workspaceId,
        userId,
        planId: String(plan._id),
        planSlug: plan.slug,
      },
    });
  } catch (err) {
    const providerMessage =
      err?.error?.description ||
      err?.response?.data?.error?.description ||
      err?.response?.data?.error?.reason ||
      err?.message ||
      "Failed to create Razorpay order";
    throw new HttpError(400, "Subscription checkout creation failed", { providerError: providerMessage });
  }

  const snapshot = buildSnapshot(plan, price);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const intent = await checkoutIntentRepository.createIntent({
    workspaceId,
    userId,
    planId: plan._id,
    planSlug: plan.slug,
    durationMonths,
    mode: "one_time",
    checkoutMode: "one_time_order",
    purpose: "subscription",
    recurringIntent: Boolean(fallbackAllowed),
    fallbackAllowed: Boolean(fallbackAllowed),
    status: "payment_pending",
    amountSnapshot: snapshot.price,
    gstSnapshot: snapshot.gst,
    featuresSnapshot: snapshot.features,
    limitsSnapshot: snapshot.limits,
    razorpayOrderId: order.id,
    idempotencyKey: hashIdempotencyParts(["subscription-checkout-one-time", workspaceId, userId, plan._id, order.id]),
    expiresAt,
    metadata: {
      fallbackAllowed: Boolean(fallbackAllowed),
      source: fallbackAllowed ? "manual_fallback" : "direct_one_time",
    },
  });

  return {
    success: true,
    message: fallbackAllowed ? "Fallback checkout created." : "Checkout order created.",
    data: {
      checkoutIntentId: String(intent._id),
      checkoutKind: "one_time_order",
      purchaseState: "created",
      fallbackAllowed: Boolean(fallbackAllowed),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || "INR",
      publicKey: razorpayKeyId,
      expiresAt,
      plan: {
        id: String(plan._id),
        slug: plan.slug,
        name: plan.name,
        pricing: snapshot.price,
        gst: snapshot.gst,
      },
    },
  };
}

async function createCheckout(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const planId = String(req.body?.planId || "").trim();
  const durationMonths = Math.max(1, Math.min(24, Number(req.body?.durationMonths || 1)));
  const requestedMode = String(req.body?.mode || "autopay").trim().toLowerCase();
  const mode = requestedMode === "one_time" ? "one_time" : "autopay";
  const fallbackAllowed = req.body?.fallbackAllowed !== false;
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!planId) throw new HttpError(400, "planId is required");

  const workspace = await fetchWorkspaceForPurchase({ workspaceId, userId, workspaceAccessRole: req.workspaceAccess?.role });
  const plan = await planRepository.findById(planId);
  assertPurchasablePlan(plan);
  if (String(workspace.plan || "").toLowerCase() === String(plan.slug || "").toLowerCase()) {
    throw new HttpError(409, "This plan is already active for the workspace");
  }

  const price = mapPlanPrice(plan);
  if (!price.payableAmountPaise || price.payableAmountPaise <= 0) {
    throw new HttpError(400, "Free plans do not require checkout");
  }

  if (mode === "one_time") {
    return createOneTimeCheckout({ workspaceId, userId, plan, durationMonths, fallbackAllowed });
  }

  return createAutopayCheckout({ workspaceId, userId, plan, durationMonths, fallbackAllowed });
}

async function verifyOrderPayment(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const orderId = String(req.body?.razorpay_order_id || req.body?.orderId || "").trim();
  const paymentId = String(req.body?.razorpay_payment_id || req.body?.paymentId || "").trim();
  const signature = String(req.body?.razorpay_signature || req.body?.signature || "").trim();
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!orderId || !paymentId || !signature) throw new HttpError(400, "Payment verification payload is incomplete");

  verifyRazorpayOrderSignature({ orderId, paymentId, signature });

  let intent = await checkoutIntentRepository.findByRazorpayOrderId(orderId);
  if (!intent) throw new HttpError(404, "Checkout intent not found");
  if (String(intent.workspaceId) !== String(workspaceId) || String(intent.userId) !== String(userId)) {
    throw new HttpError(403, "Checkout does not belong to this workspace");
  }
  if (intent.status === "paid") {
    const existing = await subscriptionRepository.findActiveByWorkspace(workspaceId);
    return { success: true, message: "Payment already verified.", data: { subscription: existing || null, purchaseState: intent.purchaseResultState || "" } };
  }
  if (intent.status === "processing") {
    throw new HttpError(409, "Payment verification is already in progress");
  }
  if (intent.status !== "payment_pending") {
    throw new HttpError(409, `Checkout is not payable (${intent.status})`);
  }

  const claimedIntent = await checkoutIntentRepository.claimProcessingByRazorpayOrderId(orderId);
  if (!claimedIntent) {
    const latest = await checkoutIntentRepository.findByRazorpayOrderId(orderId);
    if (latest?.status === "paid") {
      const existing = await subscriptionRepository.findActiveByWorkspace(workspaceId);
      return { success: true, message: "Payment already verified.", data: { subscription: existing || null, purchaseState: latest.purchaseResultState || "" } };
    }
    throw new HttpError(409, "Payment verification is already in progress");
  }
  intent = claimedIntent;

  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < Date.now()) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId, purchaseResultState: "purchase_failed" });
    throw new HttpError(400, "Checkout intent expired");
  }

  let payment;
  try {
    payment = await getRazorpayClient().payments.fetch(paymentId);
  } catch (err) {
    const providerMessage =
      err?.error?.description ||
      err?.response?.data?.error?.description ||
      err?.message ||
      "Failed to fetch Razorpay payment";
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId, purchaseResultState: "purchase_failed" });
    throw new HttpError(400, "Payment verification failed", { providerError: providerMessage });
  }
  if (String(payment?.order_id || "") !== orderId) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId, purchaseResultState: "purchase_failed" });
    throw new HttpError(400, "Payment order mismatch");
  }
  if (String(payment?.status || "") !== "captured") {
    await checkoutIntentRepository.markFailed(intent._id, {
      razorpayPaymentId: paymentId,
      providerStatus: payment?.status || "",
      purchaseResultState: "purchase_failed",
    });
    throw new HttpError(400, "Payment is not captured");
  }

  const plan = await planRepository.findById(intent.planId);
  assertPurchasablePlan(plan);
  const price = mapPlanPrice(plan);
  const expectedAmount =
    intent.purpose === "renewal"
      ? Number(intent.amountSnapshot?.payableAmountPaise || payment?.amount || 0)
      : Number(price.payableAmountPaise || 0);
  if (intent.purpose !== "renewal" && Number(intent.amountSnapshot?.payableAmountPaise || 0) !== Number(price.payableAmountPaise || 0)) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId, purchaseResultState: "purchase_failed" });
    throw new HttpError(400, "Plan price changed. Please create a fresh checkout.");
  }
  if (Number(payment?.amount || 0) !== Number(expectedAmount || 0)) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId, purchaseResultState: "purchase_failed" });
    throw new HttpError(400, "Payment amount mismatch");
  }

  if (intent.purpose === "renewal") {
    return activateRenewalPayment({ req, intent, payment, orderId, paymentId });
  }

  return activateSubscriptionPurchaseFromIntent({
    req,
    intent,
    payment,
    plan,
    orderId,
    paymentId,
    autoRenewEnabled: false,
    mandateStatus: "not_setup",
    renewalMethod: "manual",
    paymentMode: "razorpay",
    purchaseState: "activated_manual_renew",
    providerStatus: payment?.status || "captured",
    paymentMethodSnapshot: {
      provider: "razorpay",
      type: "one_time",
      label: "Manual renewal payment",
      lastPaymentId: paymentId,
      confirmedAt: new Date(),
    },
    metadata: {
      fallbackAllowed: Boolean(intent.fallbackAllowed),
      recurringIntent: Boolean(intent.recurringIntent),
      fallbackMode: "manual_renew",
    },
  });
}

async function verifySubscriptionPayment(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const subscriptionId = String(req.body?.razorpay_subscription_id || req.body?.subscriptionId || "").trim();
  const paymentId = String(req.body?.razorpay_payment_id || req.body?.paymentId || "").trim();
  const signature = String(req.body?.razorpay_signature || req.body?.signature || "").trim();
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!subscriptionId || !paymentId || !signature) throw new HttpError(400, "Payment verification payload is incomplete");

  verifyRazorpaySubscriptionSignature({ subscriptionId, paymentId, signature });

  let intent = await checkoutIntentRepository.findByRazorpaySubscriptionId(subscriptionId);
  if (!intent) throw new HttpError(404, "Subscription checkout intent not found");
  if (String(intent.workspaceId) !== String(workspaceId) || String(intent.userId) !== String(userId)) {
    throw new HttpError(403, "Checkout does not belong to this workspace");
  }
  if (intent.status === "paid") {
    const existing = await subscriptionRepository.findActiveByWorkspace(workspaceId);
    return { success: true, message: "Mandate already verified.", data: { subscription: existing || null, purchaseState: intent.purchaseResultState || "activated_with_auto_renew" } };
  }
  if (intent.status === "processing") throw new HttpError(409, "Mandate verification is already in progress");

  const claimedIntent = await checkoutIntentRepository.claimProcessingByRazorpaySubscriptionId(subscriptionId);
  if (!claimedIntent) {
    const latest = await checkoutIntentRepository.findByRazorpaySubscriptionId(subscriptionId);
    if (latest?.status === "paid") {
      const existing = await subscriptionRepository.findActiveByWorkspace(workspaceId);
      return { success: true, message: "Mandate already verified.", data: { subscription: existing || null, purchaseState: latest.purchaseResultState || "activated_with_auto_renew" } };
    }
    throw new HttpError(409, "Mandate verification is already in progress");
  }
  intent = claimedIntent;

  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < Date.now()) {
    await checkoutIntentRepository.markFailed(intent._id, {
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
      purchaseResultState: "purchase_failed",
    });
    throw new HttpError(400, "Checkout intent expired");
  }

  let subscriptionEntity;
  let payment;
  try {
    subscriptionEntity = await getRazorpayClient().subscriptions.fetch(subscriptionId);
    payment = await getRazorpayClient().payments.fetch(paymentId);
  } catch (err) {
    const providerMessage =
      err?.error?.description ||
      err?.response?.data?.error?.description ||
      err?.message ||
      "Failed to fetch Razorpay subscription";
    await checkoutIntentRepository.markPaymentPending(intent._id, {
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
      providerStatus: "pending",
      purchaseResultState: "mandate_pending",
    });
    throw new HttpError(400, "Mandate verification failed", { providerError: providerMessage });
  }

  const providerStatus = String(subscriptionEntity?.status || payment?.status || "pending").toLowerCase();
  if (payment && payment.subscription_id && String(payment.subscription_id) !== subscriptionId) {
    await checkoutIntentRepository.markFailed(intent._id, {
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
      providerStatus,
      purchaseResultState: "purchase_failed",
    });
    throw new HttpError(400, "Subscription payment mismatch");
  }

  const plan = await planRepository.findById(intent.planId);
  assertPurchasablePlan(plan);
  const price = mapPlanPrice(plan);
  if (Number(intent.amountSnapshot?.payableAmountPaise || 0) !== Number(price.payableAmountPaise || 0)) {
    await checkoutIntentRepository.markFailed(intent._id, {
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
      providerStatus,
      purchaseResultState: "purchase_failed",
    });
    throw new HttpError(400, "Plan price changed. Please create a fresh checkout.");
  }

  const mandateReady =
    ["authenticated", "active"].includes(providerStatus) ||
    ["authorized", "captured"].includes(String(payment?.status || "").toLowerCase());

  if (!mandateReady) {
    await checkoutIntentRepository.markPaymentPending(intent._id, {
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
      providerStatus,
      purchaseResultState: "mandate_pending",
    });
    return {
      success: true,
      message: "Mandate authorization is still being finalized.",
      data: {
        purchaseState: "mandate_pending",
        mandateStatus: "pending",
        subscription: null,
      },
    };
  }

  return activateSubscriptionPurchaseFromIntent({
    req,
    intent,
    payment,
    plan,
    paymentId,
    subscriptionId,
    autoRenewEnabled: true,
    mandateStatus: "active",
    renewalMethod: "razorpay_subscription",
    paymentMode: "razorpay_subscription",
    purchaseState: "activated_with_auto_renew",
    providerStatus,
    paymentMethodSnapshot: {
      provider: "razorpay",
      type: "mandate",
      label: "Razorpay recurring mandate",
      lastPaymentId: paymentId,
      confirmedAt: new Date(),
    },
    metadata: {
      recurringIntent: true,
      fallbackAllowed: Boolean(intent.fallbackAllowed),
      providerCustomerId: subscriptionEntity?.customer_id || "",
    },
  });
}

async function activateSubscriptionPurchaseFromWebhook({ eventType, payment = null, subscriptionEntity = null, webhookEventId = "" }) {
  const subscriptionId = String(subscriptionEntity?.id || payment?.subscription_id || "").trim();
  if (!subscriptionId) return { ignored: true, reason: "subscription_id_missing" };

  const existing = await subscriptionRepository.findByRazorpaySubscriptionId(subscriptionId);
  if (existing) {
    return { ignored: true, reason: "already_activated", subscriptionId: String(existing._id) };
  }

  let intent = await checkoutIntentRepository.findByRazorpaySubscriptionId(subscriptionId);
  if (!intent || intent.purpose !== "subscription") return { ignored: true, reason: "intent_not_found" };
  if (intent.status === "paid") return { ignored: true, reason: "intent_already_paid" };

  const providerStatus = String(subscriptionEntity?.status || payment?.status || "").toLowerCase();
  const mandateReady =
    ["subscription.authenticated", "subscription.activated", "payment.captured"].includes(String(eventType || "").toLowerCase()) ||
    ["authenticated", "active", "captured", "authorized"].includes(providerStatus);
  if (!mandateReady) {
    await checkoutIntentRepository.markPaymentPending(intent._id, {
      providerStatus,
      razorpayPaymentId: payment?.id || intent.razorpayPaymentId || "",
      purchaseResultState: "mandate_pending",
    });
    return { ignored: true, reason: "mandate_not_ready" };
  }

  const plan = await planRepository.findById(intent.planId);
  assertPurchasablePlan(plan);
  const paymentId = String(payment?.id || intent.razorpayPaymentId || "");
  return activateSubscriptionPurchaseFromIntent({
    intent,
    payment,
    plan,
    paymentId,
    subscriptionId,
    autoRenewEnabled: true,
    mandateStatus: "active",
    renewalMethod: "razorpay_subscription",
    paymentMode: "razorpay_subscription",
    purchaseState: "activated_with_auto_renew",
    providerStatus,
    paymentMethodSnapshot: {
      provider: "razorpay",
      type: "mandate",
      label: "Razorpay recurring mandate",
      lastPaymentId: paymentId,
      confirmedAt: new Date(),
    },
    metadata: {
      recurringIntent: true,
      fallbackAllowed: Boolean(intent.fallbackAllowed),
      providerCustomerId: subscriptionEntity?.customer_id || "",
      webhookEventId,
    },
  });
}

async function verifyPayment(req) {
  if (req.body?.razorpay_subscription_id || req.body?.subscriptionId) {
    return verifySubscriptionPayment(req);
  }
  return verifyOrderPayment(req);
}

module.exports = {
  createCheckout,
  verifyPayment,
  createOrReuseRazorpayPlan,
  createRazorpaySubscriptionWithPlanRetry,
  invalidateRazorpayPlanSync,
  activateSubscriptionPurchaseFromWebhook,
};
