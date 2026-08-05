const mongoose = require("mongoose");
const { AuditLog } = require("@infra/database/AuditLog");
const { Event } = require("@infra/database/Event");
const { Plan } = require("@infra/database/Plan");
const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");
const {
  planRepository,
  subscriptionRepository,
  invoiceRepository,
  invoiceCounterRepository,
  checkoutIntentRepository,
} = require("@modules/billing/repositories");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { hashIdempotencyParts } = require("@modules/billing/utils/idempotency");
const { getRazorpayClient, razorpayKeyId } = require("@modules/wallet/services/wallet.api.service");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");

const PLAN_ORDER = ["free", "basic", "pro", "premium", "unlimited"];
const DEFAULT_GRACE_DAYS = Math.max(1, Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7));

function addMonths(date, months) {
  const out = new Date(date);
  out.setMonth(out.getMonth() + Number(months || 1));
  return out;
}

function financialYearFor(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

function planRank(plan) {
  const slug = String(plan?.slug || "").toLowerCase();
  const fixedRank = PLAN_ORDER.indexOf(slug);
  if (fixedRank >= 0) return fixedRank;
  return Number(plan?.sortOrder || 999);
}

function mapPlanPrice(plan) {
  return calculatePrice({
    originalPricePaise: plan.pricing?.originalPricePaise ?? null,
    discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
    gstPercent: plan.pricing?.gstPercent ?? 18,
    taxMode: plan.pricing?.taxMode || "exclusive",
  });
}

function isFreePlan(plan, price = mapPlanPrice(plan)) {
  return String(plan?.slug || "").toLowerCase() === "free" || Number(price?.payableAmountPaise || 0) <= 0;
}

async function buildRuntimeFreePlan() {
  const free = await getFreePlanConfig();
  const payload = {
    name: String(free?.name || "Free"),
    description: String(free?.description || ""),
    pricing: {
      currency: "INR",
      originalPricePaise: 0,
      discountedPricePaise: 0,
      gstPercent: 0,
      taxMode: "exclusive",
      billingCycle: "monthly",
    },
    computedPreviewSnapshot: {
      discountAmountPaise: 0,
      discountPercent: 0,
      gstAmountPaise: 0,
      payableAmountPaise: 0,
    },
    trial: { enabled: false, days: 0 },
    buttonText: String(free?.buttonText || "Current Plan"),
    badgeText: "Free",
    badgeType: "none",
    cardColor: "green",
    icon: "A",
    status: "published",
    publicVisible: false,
    purchasable: false,
    recommended: false,
    sortOrder: 1,
    features: free?.features || {},
    limits: free?.limits || {},
    featureRows: Array.isArray(free?.featureRows) ? free.featureRows : [],
    displayFeatures: Array.isArray(free?.displayFeatures) ? free.displayFeatures : [],
    unavailableFeatures: Array.isArray(free?.unavailableFeatures) ? free.unavailableFeatures : [],
    addonServices: Array.isArray(free?.addonServices) ? free.addonServices : [],
  };

  const plan = await Plan.findOneAndUpdate(
    { slug: "free" },
    {
      $set: payload,
      $setOnInsert: {
        slug: "free",
        planType: "custom",
        createdBy: null,
      },
      $unset: {
        deletedAt: 1,
        deletedBy: 1,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return plan;
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + Number(days || 0));
  return out;
}

function buildSnapshot(plan, price = mapPlanPrice(plan)) {
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

function assertPlanUsable(plan) {
  if (!plan || plan.deletedAt) throw new HttpError(404, "Plan not found");
  if (plan.status !== "published") throw new HttpError(400, "Plan is not published");
  if (!plan.publicVisible || !plan.purchasable) throw new HttpError(400, "Plan is not purchasable");
}

async function writeBillingEvent({ req, workspaceId, userId, action, subscriptionId, dedupeKey = "", metadata = {} }) {
  try {
    await AuditLog.create({
      actorId: userId || req?.user?.id || undefined,
      targetId: userId || req?.user?.id || undefined,
      action,
      resourceType: "billing",
      resourceId: String(subscriptionId || workspaceId || ""),
      ...(dedupeKey ? { dedupeKey } : {}),
      metadata: { workspaceId: String(workspaceId || req?.workspace?.id || ""), ...metadata },
      ip: String(req?.ip || ""),
      userAgent: String(req?.headers?.["user-agent"] || ""),
    });
  } catch (err) {
    if (String(err?.code) === "11000") return;
    // Audit/timeline should never break billing lifecycle.
  }
}

async function writeRenewalNotificationEvent({ workspaceId, eventName, metadata = {} }) {
  try {
    await Event.create({
      workspaceId,
      eventName,
      phone: "billing",
      templatePayload: metadata,
      status: "triggered",
    });
  } catch {
    // Notification event preparation must never block billing lifecycle.
  }
}

async function updateWorkspaceEntitlements(workspaceId, plan, options = {}) {
  const workspace = await Workspace.findById(workspaceId).session(options.session || null);
  if (!workspace) throw new HttpError(404, "Workspace not found");
  workspace.plan = plan.slug;
  workspace.crmEnabled = Boolean(plan.features?.crmPageAccess || plan.features?.crmAccess);
  workspace.features = workspace.features || {};
  workspace.features.externalChatApiAccess = Boolean(plan.features?.externalChatApiAccess);
  workspace.allowedApiPermissions = workspace.allowedApiPermissions || {};
  workspace.allowedApiPermissions.chatAccess = Boolean(plan.features?.externalChatApiAccess);
  await workspace.save({ session: options.session });
  return workspace;
}

async function createBasicInvoice({
  workspaceId,
  userId,
  subscription,
  plan,
  payment = {},
  createdBy = null,
  status = "generated",
  paymentStatus = "",
  renewalType = "",
  dueDate = null,
  session = null,
}) {
  const existingPrice = subscription?.snapshot?.price || {};
  const existingGst = subscription?.snapshot?.gst || {};
  const price = mapPlanPrice(plan);
  const financialYear = financialYearFor(subscription.currentPeriodStart || new Date());
  const sequence = await invoiceCounterRepository.nextSequence({ financialYear, prefix: "INV" });
  const invoiceNumber = `INV-${financialYear}-${String(sequence).padStart(5, "0")}`;
  const payableAmountPaise = Number(existingPrice.payableAmountPaise ?? price.payableAmountPaise ?? 0);
  const gstAmountPaise = Number(existingGst.gstAmountPaise ?? price.gstAmountPaise ?? 0);
  const subtotalPaise = Math.max(0, payableAmountPaise - gstAmountPaise);

  try {
    return await invoiceRepository.createInvoice({
      invoiceNumber,
      financialYear,
      sequence,
      workspaceId,
      userId,
      subscriptionId: subscription._id,
      planId: plan._id,
      planSlug: plan.slug,
      planName: plan.name,
      status,
      paymentStatus,
      renewalType,
      dueDate,
      billingPeriod: {
        start: subscription.currentPeriodStart,
        end: subscription.currentPeriodEnd,
        durationMonths: Number(subscription.durationMonths || 1),
      },
      items: [
        {
          label: `${plan.name} subscription`,
          quantity: 1,
          amountPaise: subtotalPaise,
          gstAmountPaise,
          totalPaise: payableAmountPaise,
        },
      ],
      amounts: {
        subtotalPaise,
        gstAmountPaise,
        totalPaise: payableAmountPaise,
        currency: "INR",
      },
      payment,
      createdBy,
    }, { session });
  } catch (err) {
    if (String(err?.code) === "11000") return null;
    throw err;
  }
}

async function createRenewalInvoice({ workspaceId, userId, subscription, plan, previousSubscription, dueDate, now = new Date() }) {
  return createBasicInvoice({
    workspaceId,
    userId,
    subscription,
    plan,
    status: "pending",
    paymentStatus: "pending",
    renewalType: "scheduled_downgrade",
    dueDate,
    payment: {
      provider: "razorpay",
      status: "pending",
      retryCount: 0,
      previousSubscriptionId: previousSubscription ? String(previousSubscription._id) : null,
      createdAt: now,
    },
    createdBy: userId,
  });
}

async function scheduleDowngrade(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  const planId = String(req.body?.planId || "").trim();
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!planId) throw new HttpError(400, "planId is required");

  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!active) throw new HttpError(400, "No active subscription found");
  if (active.scheduledChange?.planId) throw new HttpError(409, "A plan change is already scheduled");

  const targetPlan = await planRepository.findById(planId);
  assertPlanUsable(targetPlan);
  if (String(active.planId) === String(targetPlan._id) || active.planSlug === targetPlan.slug) {
    throw new HttpError(409, "This plan is already active");
  }

  const currentPlan = await planRepository.findById(active.planId);
  const currentRank = currentPlan ? planRank(currentPlan) : planRank({ slug: active.planSlug });
  if (planRank(targetPlan) >= currentRank) {
    throw new HttpError(400, "Use checkout to upgrade or switch to a higher plan");
  }

  const now = new Date();
  active.cancelAtPeriodEnd = true;
  active.scheduledChange = {
    type: "downgrade",
    planId: targetPlan._id,
    planSlug: targetPlan.slug,
    planName: targetPlan.name,
    effectiveAt: active.currentPeriodEnd,
    requestedBy: userId,
    requestedAt: now,
  };
  await active.save();

  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.downgrade_scheduled",
    subscriptionId: active._id,
    metadata: { fromPlan: active.planSlug, toPlan: targetPlan.slug, effectiveAt: active.currentPeriodEnd },
  });

  return { success: true, message: "Downgrade scheduled.", data: { subscription: serializeSubscription(active) } };
}

async function cancelScheduledChange(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");

  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!active) throw new HttpError(400, "No active subscription found");
  if (!active.scheduledChange?.planId) {
    return { success: true, message: "No scheduled change found.", data: { subscription: serializeSubscription(active) } };
  }

  const previous = active.scheduledChange;
  active.cancelAtPeriodEnd = false;
  active.scheduledChange = {
    type: "",
    planId: null,
    planSlug: "",
    planName: "",
    effectiveAt: null,
    requestedBy: null,
    requestedAt: null,
  };
  await active.save();

  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.scheduled_change_cancelled",
    subscriptionId: active._id,
    metadata: { cancelledPlan: previous.planSlug, effectiveAt: previous.effectiveAt },
  });

  return { success: true, message: "Scheduled change cancelled.", data: { subscription: serializeSubscription(active) } };
}

async function activatePlanForWorkspace({ workspaceId, userId, plan, previousSubscription, reason, now = new Date() }) {
  const durationMonths = Math.max(1, Number(previousSubscription?.durationMonths || 1));
  const price = mapPlanPrice(plan);
  const subscription = await subscriptionRepository.createSubscription({
    workspaceId,
    userId,
    planId: plan._id,
    planSlug: plan.slug,
    planName: plan.name,
    planType: plan.planType || "custom",
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: addMonths(now, durationMonths),
    startedAt: now,
    purchasedAt: now,
    validUntil: addMonths(now, durationMonths),
    durationMonths,
    autoRenewEnabled: false,
    cancelAtPeriodEnd: false,
    snapshot: buildSnapshot(plan, price),
    paymentMode: reason === "free_fallback" ? "free" : "system",
    metadata: {
      source: reason,
      previousSubscriptionId: previousSubscription ? String(previousSubscription._id) : null,
    },
  });
  await updateWorkspaceEntitlements(workspaceId, plan);
  return subscription;
}

async function createPaymentDueSubscription({ workspaceId, userId, plan, previousSubscription, now = new Date() }) {
  const existing = await subscriptionRepository.findPaymentDueByWorkspace(workspaceId);
  if (existing) return existing;
  const durationMonths = Math.max(1, Number(previousSubscription?.durationMonths || 1));
  const price = mapPlanPrice(plan);
  return subscriptionRepository.createSubscription({
    workspaceId,
    userId,
    planId: plan._id,
    planSlug: plan.slug,
    planName: plan.name,
    planType: plan.planType || "custom",
    status: "payment_due",
    currentPeriodStart: now,
    currentPeriodEnd: addMonths(now, durationMonths),
    startedAt: null,
    purchasedAt: null,
    validUntil: addMonths(now, durationMonths),
    durationMonths,
    autoRenewEnabled: false,
    cancelAtPeriodEnd: false,
    paymentDueAt: now,
    gracePeriodEndsAt: addDays(now, DEFAULT_GRACE_DAYS),
    snapshot: buildSnapshot(plan, price),
    paymentMode: "razorpay",
    metadata: {
      source: "scheduled_downgrade_payment_due",
      previousSubscriptionId: previousSubscription ? String(previousSubscription._id) : null,
    },
  });
}

async function startRenewalPaymentDue({ sub, plan, now = new Date() }) {
  const workspaceId = sub.workspaceId;
  const userId = sub.userId;
  const gracePeriodEndsAt = addDays(now, DEFAULT_GRACE_DAYS);
  const paymentDue = await createPaymentDueSubscription({ workspaceId, userId, plan, previousSubscription: sub, now });
  let invoice = paymentDue.renewalInvoiceId ? await invoiceRepository.findById(paymentDue.renewalInvoiceId) : null;
  if (!invoice) {
    invoice = await createRenewalInvoice({
      workspaceId,
      userId,
      subscription: paymentDue,
      plan,
      previousSubscription: sub,
      dueDate: gracePeriodEndsAt,
      now,
    });
    paymentDue.renewalInvoiceId = invoice?._id || null;
    await paymentDue.save();
  }

  sub.status = "grace_period";
  sub.paymentDueAt = now;
  sub.gracePeriodEndsAt = gracePeriodEndsAt;
  sub.renewalInvoiceId = invoice?._id || null;
  sub.cancelAtPeriodEnd = true;
  await sub.save();

  await writeBillingEvent({
    workspaceId,
    userId,
    action: "billing.renewal_invoice_created",
    subscriptionId: paymentDue._id,
    metadata: { invoiceId: invoice ? String(invoice._id) : null, fromPlan: sub.planSlug, toPlan: plan.slug },
  });
  await writeBillingEvent({
    workspaceId,
    userId,
    action: "billing.grace_period_started",
    subscriptionId: sub._id,
    metadata: { invoiceId: invoice ? String(invoice._id) : null, gracePeriodEndsAt, targetPlan: plan.slug },
  });
  await writeRenewalNotificationEvent({
    workspaceId,
    eventName: "billing.renewal_due",
    metadata: { invoiceId: invoice ? String(invoice._id) : null, targetPlan: plan.slug, gracePeriodEndsAt },
  });
  await writeRenewalNotificationEvent({
    workspaceId,
    eventName: "billing.grace_period_started",
    metadata: { invoiceId: invoice ? String(invoice._id) : null, targetPlan: plan.slug, gracePeriodEndsAt },
  });

  return { paymentDue, invoice };
}

async function createRenewalPaymentOrder(req) {
  const workspaceId = req.workspace?.id;
  const userId = req.user?.id;
  if (!workspaceId) throw new HttpError(400, "Workspace is required");
  if (!userId) throw new HttpError(401, "Authentication required");

  const paymentDue = await subscriptionRepository.findPaymentDueByWorkspace(workspaceId);
  if (!paymentDue) throw new HttpError(400, "No renewal payment is due");
  if (paymentDue.gracePeriodEndsAt && new Date(paymentDue.gracePeriodEndsAt).getTime() < Date.now()) {
    throw new HttpError(400, "Renewal payment window has expired");
  }

  const invoiceId = String(req.body?.invoiceId || paymentDue.renewalInvoiceId || "").trim();
  const invoice = invoiceId ? await invoiceRepository.findById(invoiceId) : null;
  if (!invoice || String(invoice.workspaceId) !== String(workspaceId)) throw new HttpError(404, "Renewal invoice not found");
  if (invoice.paymentStatus === "paid" || invoice.status === "paid") throw new HttpError(409, "Renewal invoice is already paid");
  if (!["pending", "failed"].includes(String(invoice.paymentStatus || "pending"))) throw new HttpError(400, "Invoice is not payable");

  const amount = Number(invoice.amounts?.totalPaise || 0);
  if (!amount || amount <= 0) throw new HttpError(400, "Renewal invoice does not require payment");
  const existingOrderId = String(invoice.payment?.providerOrderId || "");
  const lastRetryAt = invoice.payment?.lastRetryAt ? new Date(invoice.payment.lastRetryAt) : null;
  if (existingOrderId && lastRetryAt && Date.now() - lastRetryAt.getTime() < 30 * 60 * 1000) {
    return {
      success: true,
      message: "Existing renewal checkout reused.",
      data: {
        checkoutIntentId: invoice.payment?.checkoutIntentId || "",
        orderId: existingOrderId,
        amount,
        currency: invoice.amounts?.currency || "INR",
        publicKey: razorpayKeyId,
        expiresAt: new Date(lastRetryAt.getTime() + 30 * 60 * 1000),
        invoice: {
          id: String(invoice._id),
          invoiceNumber: invoice.invoiceNumber,
          dueDate: invoice.dueDate,
        },
        plan: {
          id: String(paymentDue.planId),
          slug: paymentDue.planSlug,
          name: paymentDue.planName,
          pricing: paymentDue.snapshot?.price || {},
          gst: paymentDue.snapshot?.gst || {},
        },
      },
    };
  }

  let order;
  try {
    order = await getRazorpayClient().orders.create({
      amount,
      currency: invoice.amounts?.currency || "INR",
      receipt: `ren_${String(workspaceId).replace(/[^a-zA-Z0-9]/g, "").slice(-10)}_${Date.now().toString(36)}`.slice(0, 40),
      notes: {
        purpose: "renewal",
        workspaceId: String(workspaceId),
        userId: String(userId),
        invoiceId: String(invoice._id),
        subscriptionId: String(paymentDue._id),
        planSlug: paymentDue.planSlug,
      },
    });
  } catch (err) {
    const providerMessage = err?.error?.description || err?.response?.data?.error?.description || err?.message || "Failed to create renewal order";
    throw new HttpError(400, "Renewal checkout creation failed", { providerError: providerMessage });
  }

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const intent = await checkoutIntentRepository.createIntent({
    workspaceId,
    userId,
    planId: paymentDue.planId,
    planSlug: paymentDue.planSlug,
    durationMonths: paymentDue.durationMonths,
    mode: "one_time",
    purpose: "renewal",
    status: "payment_pending",
    amountSnapshot: paymentDue.snapshot?.price || {},
    gstSnapshot: paymentDue.snapshot?.gst || {},
    featuresSnapshot: paymentDue.snapshot?.features || {},
    limitsSnapshot: paymentDue.snapshot?.limits || {},
    razorpayOrderId: order.id,
    renewalInvoiceId: invoice._id,
    renewalSubscriptionId: paymentDue._id,
    previousSubscriptionId: paymentDue.metadata?.previousSubscriptionId || null,
    idempotencyKey: hashIdempotencyParts(["renewal-checkout", workspaceId, invoice._id, order.id]),
    expiresAt,
  });

  await invoiceRepository.markPaymentPending(invoice._id, {
    "payment.provider": "razorpay",
    "payment.providerOrderId": order.id,
    "payment.lastRetryAt": new Date(),
    "payment.checkoutIntentId": String(intent._id),
  });
  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.retry_payment",
    subscriptionId: paymentDue._id,
    metadata: { invoiceId: String(invoice._id), razorpayOrderId: order.id },
  });

  return {
    success: true,
    message: "Renewal checkout created.",
    data: {
      checkoutIntentId: String(intent._id),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || "INR",
      publicKey: razorpayKeyId,
      expiresAt,
      invoice: {
        id: String(invoice._id),
        invoiceNumber: invoice.invoiceNumber,
        dueDate: invoice.dueDate,
      },
      plan: {
        id: String(paymentDue.planId),
        slug: paymentDue.planSlug,
        name: paymentDue.planName,
        pricing: paymentDue.snapshot?.price || {},
        gst: paymentDue.snapshot?.gst || {},
      },
    },
  };
}

async function activateRenewalPayment({ req, intent, payment, orderId, paymentId }) {
  const workspaceId = intent.workspaceId;
  const userId = intent.userId;
  const now = new Date();
  let paymentDue;
  let invoice;
  let alreadyVerified = false;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      paymentDue = await subscriptionRepository.findById(intent.renewalSubscriptionId, { session });
      if (!paymentDue || paymentDue.status !== "payment_due") throw new HttpError(400, "Renewal is not in payment due state");
      invoice = await invoiceRepository.findById(intent.renewalInvoiceId || paymentDue.renewalInvoiceId, { session });
      if (!invoice || String(invoice.workspaceId) !== String(workspaceId)) throw new HttpError(404, "Renewal invoice not found");
      if (invoice.paymentStatus === "paid") {
        alreadyVerified = true;
        return;
      }

      await invoiceRepository.markPaid(invoice._id, {
        "payment.provider": "razorpay",
        "payment.providerOrderId": orderId,
        "payment.providerPaymentId": paymentId,
        "payment.amountPaise": Number(payment?.amount || invoice.amounts?.totalPaise || 0),
        "payment.status": payment?.status || "captured",
        "payment.paidAt": now,
      }, { session });
      await checkoutIntentRepository.markPaid(intent._id, { razorpayPaymentId: paymentId }, { session });

      const previousId = paymentDue.metadata?.previousSubscriptionId || intent.previousSubscriptionId;
      const previous = previousId
        ? await subscriptionRepository.findById(previousId, { session })
        : await subscriptionRepository.findActiveByWorkspace(workspaceId, { session });
      if (previous && String(previous._id) !== String(paymentDue._id)) {
        previous.$session(session);
        previous.status = "expired";
        previous.expiredAt = now;
        previous.replacedBySubscriptionId = paymentDue._id;
        previous.cancelAtPeriodEnd = false;
        await previous.save({ session });
      }

      await subscriptionRepository.cancelActiveByWorkspace(workspaceId, {
        status: "expired",
        expiredAt: now,
        replacedBySubscriptionId: paymentDue._id,
      }, { session });

      paymentDue.$session(session);
      paymentDue.status = "active";
      paymentDue.startedAt = now;
      paymentDue.purchasedAt = now;
      paymentDue.paymentDueAt = null;
      paymentDue.gracePeriodEndsAt = null;
      paymentDue.metadata = {
        ...(paymentDue.metadata || {}),
        source: "renewal_payment_verified",
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
      };
      await paymentDue.save({ session });

      const plan = await planRepository.findById(paymentDue.planId);
      if (plan) await updateWorkspaceEntitlements(workspaceId, plan, { session });
    });
  } catch (err) {
    await checkoutIntentRepository.markPaymentPending(intent._id, {
      activationError: err?.message || "renewal_activation_failed",
    });
    throw err;
  } finally {
    await session.endSession();
  }

  if (alreadyVerified) {
    const latest = await subscriptionRepository.findById(paymentDue._id);
    if (latest?.status === "active") {
      return { success: true, message: "Renewal payment already verified.", data: { subscription: serializeSubscription(latest) } };
    }
  }

  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.renewal_payment_completed",
    subscriptionId: paymentDue._id,
    metadata: { invoiceId: String(invoice._id), toPlan: paymentDue.planSlug, razorpayPaymentId: paymentId },
  });
  await writeBillingEvent({
    req,
    workspaceId,
    userId,
    action: "billing.paid_plan_activated",
    subscriptionId: paymentDue._id,
    metadata: { invoiceId: String(invoice._id), plan: paymentDue.planSlug },
  });
  await writeRenewalNotificationEvent({
    workspaceId,
    eventName: "billing.payment_successful",
    metadata: { invoiceId: String(invoice._id), plan: paymentDue.planSlug },
  });
  await writeRenewalNotificationEvent({
    workspaceId,
    eventName: "billing.plan_activated",
    metadata: { invoiceId: String(invoice._id), plan: paymentDue.planSlug },
  });

  return {
    success: true,
    message: "Renewal payment verified and plan activated.",
    data: { subscription: serializeSubscription(paymentDue) },
  };
}

async function processExpiredSubscriptions({ now = new Date(), limit = 100 } = {}) {
  const expired = await subscriptionRepository.listExpiredActive(now, { limit });
  const results = [];
  for (const row of expired) {
    const sub = await subscriptionRepository.claimLifecycleLock(row._id, now, new Date(now.getTime() + 5 * 60 * 1000));
    if (!sub) continue;
    const workspaceId = sub.workspaceId;
    const userId = sub.userId;
    let nextPlan = null;
    let reason = "free_fallback";
    if (sub.scheduledChange?.type === "downgrade" && sub.scheduledChange?.planId) {
      nextPlan = await planRepository.findById(sub.scheduledChange.planId);
      reason = "scheduled_downgrade";
    }
    if (!nextPlan || nextPlan.deletedAt || nextPlan.status !== "published") {
      nextPlan = await planRepository.findBySlug("free");
      if (!nextPlan || nextPlan.deletedAt || nextPlan.status !== "published") {
        nextPlan = await buildRuntimeFreePlan();
      }
      reason = "free_fallback";
    }

    if (nextPlan && !nextPlan.deletedAt && nextPlan.status === "published") {
      const nextPrice = mapPlanPrice(nextPlan);
      if (reason === "scheduled_downgrade" && !isFreePlan(nextPlan, nextPrice)) {
        const due = await startRenewalPaymentDue({ sub, plan: nextPlan, now });
        results.push({
          subscriptionId: String(sub._id),
          renewalSubscriptionId: String(due.paymentDue._id),
          invoiceId: due.invoice ? String(due.invoice._id) : null,
          plan: nextPlan.slug,
          status: "payment_due",
        });
        continue;
      }

      sub.status = "expired";
      sub.expiredAt = now;
      sub.cancelAtPeriodEnd = false;
      await sub.save();
      const created = await activatePlanForWorkspace({
        workspaceId,
        userId,
        plan: nextPlan,
        previousSubscription: sub,
        reason,
        now,
      });
      sub.replacedBySubscriptionId = created._id;
      await sub.save();
      await writeBillingEvent({
        workspaceId,
        userId,
        action: reason === "scheduled_downgrade" ? "billing.downgrade_activated" : "billing.free_fallback_activated",
        subscriptionId: created._id,
        metadata: { fromPlan: sub.planSlug, toPlan: nextPlan.slug },
      });
      results.push({ subscriptionId: String(sub._id), replacementId: String(created._id), plan: nextPlan.slug });
    } else {
      sub.status = "expired";
      sub.expiredAt = now;
      sub.cancelAtPeriodEnd = false;
      await sub.save();
      results.push({ subscriptionId: String(sub._id), replacementId: null, plan: null, warning: "Free plan not found" });
    }
    await subscriptionRepository.releaseLifecycleLock(sub._id);
  }
  const graceExpired = await subscriptionRepository.listExpiredGrace(now, { limit });
  for (const row of graceExpired) {
    const sub = await subscriptionRepository.claimLifecycleLock(row._id, now, new Date(now.getTime() + 5 * 60 * 1000));
    if (!sub) continue;
    const paymentDue = await subscriptionRepository.findPaymentDueByWorkspace(sub.workspaceId);
    if (paymentDue?.renewalInvoiceId) {
      await invoiceRepository.markExpired(paymentDue.renewalInvoiceId, { "payment.status": "expired" });
    }
    if (paymentDue) {
      paymentDue.status = "cancelled";
      paymentDue.cancelledAt = now;
      await paymentDue.save();
    }
    sub.status = "expired";
    sub.expiredAt = now;
    sub.cancelAtPeriodEnd = false;
    await sub.save();
    let freePlan = await planRepository.findBySlug("free");
    if (!freePlan || freePlan.status !== "published") {
      freePlan = await buildRuntimeFreePlan();
    }
    if (freePlan) {
      const created = await activatePlanForWorkspace({
        workspaceId: sub.workspaceId,
        userId: sub.userId,
        plan: freePlan,
        previousSubscription: sub,
        reason: "free_fallback",
        now,
      });
      sub.replacedBySubscriptionId = created._id;
      await sub.save();
      await writeBillingEvent({
        workspaceId: sub.workspaceId,
        userId: sub.userId,
        action: "billing.grace_period_expired",
        subscriptionId: sub._id,
        metadata: { targetPlan: paymentDue?.planSlug || "", fallbackPlan: "free" },
      });
      await writeBillingEvent({
        workspaceId: sub.workspaceId,
        userId: sub.userId,
        action: "billing.free_plan_activated",
        subscriptionId: created._id,
        metadata: { fromPlan: sub.planSlug, reason: "renewal_failed" },
      });
      await writeRenewalNotificationEvent({
        workspaceId: sub.workspaceId,
        eventName: "billing.grace_period_expired",
        metadata: { targetPlan: paymentDue?.planSlug || "", fallbackPlan: "free" },
      });
      await writeRenewalNotificationEvent({
        workspaceId: sub.workspaceId,
        eventName: "billing.plan_expired",
        metadata: { plan: sub.planSlug, fallbackPlan: "free" },
      });
      results.push({ subscriptionId: String(sub._id), replacementId: String(created._id), plan: "free", status: "free_fallback" });
    }
    await subscriptionRepository.releaseLifecycleLock(sub._id);
  }
  return { processed: results.length, items: results };
}

function serializeSubscription(s) {
  return {
    id: String(s._id),
    planSlug: s.planSlug,
    planName: s.planName,
    status: s.status,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(s.cancelAtPeriodEnd),
    paymentDueAt: s.paymentDueAt || null,
    gracePeriodEndsAt: s.gracePeriodEndsAt || null,
    renewalInvoiceId: s.renewalInvoiceId ? String(s.renewalInvoiceId) : null,
    scheduledChange: s.scheduledChange?.planId
      ? {
          type: s.scheduledChange.type,
          planId: String(s.scheduledChange.planId),
          planSlug: s.scheduledChange.planSlug,
          planName: s.scheduledChange.planName,
          effectiveAt: s.scheduledChange.effectiveAt,
          requestedAt: s.scheduledChange.requestedAt,
        }
      : null,
  };
}

async function getRenewalStatus(req) {
  const workspaceId = req.workspace?.id;
  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  const paymentDue = await subscriptionRepository.findPaymentDueByWorkspace(workspaceId);
  const invoice = paymentDue?.renewalInvoiceId ? await invoiceRepository.findById(paymentDue.renewalInvoiceId) : null;
  return {
    success: true,
    message: "Renewal status fetched.",
    data: {
      active: active ? serializeSubscription(active) : null,
      paymentDue: paymentDue
        ? {
            subscription: serializeSubscription(paymentDue),
            invoice: invoice
              ? {
                  id: String(invoice._id),
                  invoiceNumber: invoice.invoiceNumber,
                  status: invoice.status,
                  paymentStatus: invoice.paymentStatus,
                  dueDate: invoice.dueDate,
                  totalPaise: Number(invoice.amounts?.totalPaise || 0),
                  currency: invoice.amounts?.currency || "INR",
                }
              : null,
          }
        : null,
    },
  };
}

async function listInvoices(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20) || 20, 5), 50);
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    invoiceRepository.listByWorkspace(req.workspace.id, { skip, limit }),
    invoiceRepository.countByWorkspace(req.workspace.id),
  ]);
  return {
    success: true,
    message: "Invoices fetched.",
    data: {
      items: rows.map((item) => ({
        id: String(item._id),
        invoiceNumber: item.invoiceNumber,
        status: item.status,
        paymentStatus: item.paymentStatus || "",
        renewalType: item.renewalType || "",
        dueDate: item.dueDate || null,
        planName: item.planName,
        planSlug: item.planSlug,
        totalPaise: Number(item.amounts?.totalPaise || 0),
        gstAmountPaise: Number(item.amounts?.gstAmountPaise || 0),
        currency: item.amounts?.currency || "INR",
        billingPeriod: item.billingPeriod,
        payment: item.payment || {},
        createdAt: item.createdAt,
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    },
  };
}

async function listTimeline(req) {
  const limit = Math.min(Math.max(Number(req.query.limit || 30) || 30, 5), 100);
  const rows = await AuditLog.find({
    resourceType: "billing",
    "metadata.workspaceId": String(req.workspace.id),
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return {
    success: true,
    message: "Billing timeline fetched.",
    data: {
      items: rows.map((row) => ({
        id: String(row._id),
        action: row.action,
        metadata: row.metadata || {},
        createdAt: row.createdAt,
      })),
    },
  };
}

module.exports = {
  scheduleDowngrade,
  cancelScheduledChange,
  processExpiredSubscriptions,
  createRenewalPaymentOrder,
  activateRenewalPayment,
  getRenewalStatus,
  listInvoices,
  listTimeline,
  createBasicInvoice,
  writeBillingEvent,
};
