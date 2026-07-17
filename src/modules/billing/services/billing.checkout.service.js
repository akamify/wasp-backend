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

function buildReceipt(workspaceId) {
  const ws = String(workspaceId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-10) || "ws";
  return `sub_${ws}_${Date.now().toString(36)}`.slice(0, 40);
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

function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  if (!razorpayKeySecret) throw new HttpError(400, "Razorpay credentials not configured");
  const expected = crypto
    .createHmac("sha256", razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const received = String(signature || "");
  if (!received || expected.length !== received.length) throw new HttpError(401, "Invalid payment signature");
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  if (!ok) throw new HttpError(401, "Invalid payment signature");
}

async function createCheckout(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const planId = String(req.body?.planId || "").trim();
  const durationMonths = Math.max(1, Math.min(24, Number(req.body?.durationMonths || 1)));
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!planId) throw new HttpError(400, "planId is required");

  const workspace = await Workspace.findById(workspaceId).select("ownerId ownerUserId name plan isActive status");
  if (!workspace || !workspace.isActive || workspace.status === "deleted") throw new HttpError(404, "Workspace not found");
  const isOwner = String(workspace.ownerUserId || workspace.ownerId) === String(userId);
  if (!isOwner && req.workspaceAccess?.role !== "owner") throw new HttpError(403, "Only workspace owner can purchase a subscription");

  const plan = await planRepository.findById(planId);
  assertPurchasablePlan(plan);
  if (String(workspace.plan || "").toLowerCase() === String(plan.slug || "").toLowerCase()) {
    throw new HttpError(409, "This plan is already active for the workspace");
  }

  const price = mapPlanPrice(plan);
  if (!price.payableAmountPaise || price.payableAmountPaise <= 0) {
    throw new HttpError(400, "Free plans do not require checkout");
  }

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
    purpose: "subscription",
    status: "payment_pending",
    amountSnapshot: snapshot.price,
    gstSnapshot: snapshot.gst,
    featuresSnapshot: snapshot.features,
    limitsSnapshot: snapshot.limits,
    razorpayOrderId: order.id,
    idempotencyKey: hashIdempotencyParts(["subscription-checkout", workspaceId, userId, plan._id, order.id]),
    expiresAt,
  });

  return {
    success: true,
    message: "Checkout order created.",
    data: {
      checkoutIntentId: String(intent._id),
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

async function verifyPayment(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const orderId = String(req.body?.razorpay_order_id || req.body?.orderId || "").trim();
  const paymentId = String(req.body?.razorpay_payment_id || req.body?.paymentId || "").trim();
  const signature = String(req.body?.razorpay_signature || req.body?.signature || "").trim();
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!orderId || !paymentId || !signature) throw new HttpError(400, "Payment verification payload is incomplete");

  verifyRazorpaySignature({ orderId, paymentId, signature });

  let intent = await checkoutIntentRepository.findByRazorpayOrderId(orderId);
  if (!intent) throw new HttpError(404, "Checkout intent not found");
  if (String(intent.workspaceId) !== String(workspaceId) || String(intent.userId) !== String(userId)) {
    throw new HttpError(403, "Checkout does not belong to this workspace");
  }
  if (intent.status === "paid") {
    const existing = await subscriptionRepository.findActiveByWorkspace(workspaceId);
    return { success: true, message: "Payment already verified.", data: { subscription: existing || null } };
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
      return { success: true, message: "Payment already verified.", data: { subscription: existing || null } };
    }
    throw new HttpError(409, "Payment verification is already in progress");
  }
  intent = claimedIntent;
  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < Date.now()) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId });
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
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId });
    throw new HttpError(400, "Payment verification failed", { providerError: providerMessage });
  }
  if (String(payment?.order_id || "") !== orderId) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId });
    throw new HttpError(400, "Payment order mismatch");
  }
  if (String(payment?.status || "") !== "captured") {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId, providerStatus: payment?.status || "" });
    throw new HttpError(400, "Payment is not captured");
  }

  const plan = await planRepository.findById(intent.planId);
  assertPurchasablePlan(plan);
  const price = mapPlanPrice(plan);
  const expectedAmount = intent.purpose === "renewal"
    ? Number(intent.amountSnapshot?.payableAmountPaise || payment?.amount || 0)
    : Number(price.payableAmountPaise || 0);
  if (intent.purpose !== "renewal" && Number(intent.amountSnapshot?.payableAmountPaise || 0) !== Number(price.payableAmountPaise || 0)) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId });
    throw new HttpError(400, "Plan price changed. Please create a fresh checkout.");
  }
  if (Number(payment?.amount || 0) !== Number(expectedAmount || 0)) {
    await checkoutIntentRepository.markFailed(intent._id, { razorpayPaymentId: paymentId });
    throw new HttpError(400, "Payment amount mismatch");
  }

  if (intent.purpose === "renewal") {
    return activateRenewalPayment({ req, intent, payment, orderId, paymentId });
  }

  const now = new Date();
  const currentPeriodEnd = addMonths(now, intent.durationMonths);
  const snapshot = buildSnapshot(plan, price);
  let created;
  let previousPlanSlug = "free";
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

      await subscriptionRepository.cancelActiveByWorkspace(workspaceId, {
        status: "cancelled",
        cancelledAt: now,
        metadata: {
          bulkReplacementReason: "user_upgrade",
          replacedByCheckoutIntentId: String(intent._id),
        },
      }, { session });

      created = await subscriptionRepository.createSubscription({
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
        autoRenewEnabled: false,
        cancelAtPeriodEnd: false,
        latestCheckoutIntentId: intent._id,
        snapshot,
        paymentMode: "razorpay",
        metadata: {
          source: "user_checkout",
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          previousSubscriptionId: active ? String(active._id) : null,
        },
      }, { session });

      if (active) {
        active.replacedBySubscriptionId = created._id;
        await active.save({ session });
      }

      await checkoutIntentRepository.markPaid(intent._id, { razorpayPaymentId: paymentId }, { session });
      await createBasicInvoice({
        workspaceId,
        userId,
        subscription: created,
        plan,
        payment: {
          provider: "razorpay",
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          amountPaise: Number(payment?.amount || price.payableAmountPaise || 0),
          status: payment?.status || "captured",
        },
        createdBy: userId,
        session,
      });

      workspace.plan = plan.slug;
      workspace.crmEnabled = Boolean(plan.features?.crmAccess);
      workspace.features = workspace.features || {};
      workspace.features.externalChatApiAccess = Boolean(plan.features?.externalChatApiAccess);
      workspace.allowedApiPermissions = workspace.allowedApiPermissions || {};
      workspace.allowedApiPermissions.chatAccess = Boolean(plan.features?.externalChatApiAccess);
      await workspace.save({ session });
    });
  } catch (err) {
    await checkoutIntentRepository.markPaymentPending(intent._id, {
      activationError: err?.message || "activation_failed",
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
    dedupeKey: `billing:payment:${paymentId}:activated`,
    metadata: {
      fromPlan: previousPlanSlug,
      toPlan: plan.slug,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
    },
  });

  return {
    success: true,
    message: "Subscription activated.",
    data: {
      subscription: {
        id: String(created._id),
        planSlug: created.planSlug,
        planName: created.planName,
        status: created.status,
        currentPeriodStart: created.currentPeriodStart,
        currentPeriodEnd: created.currentPeriodEnd,
        features: snapshot.features,
        limits: snapshot.limits,
      },
      workspace: {
        id: String(workspace._id),
        plan: workspace.plan,
      },
    },
  };
}

module.exports = { createCheckout, verifyPayment };
