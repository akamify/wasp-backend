const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { encryptCommerceSecret } = require("./commerceSecrets.service");
const { randomToken } = require("../domain/gateway");
const { assertCapturedPayment } = require("../domain/states");
const { assertNativeCapture } = require("../domain/nativePayments");
const { same, fail, linkPayload, assertLink, foundLink, paymentUrl, assertProviderOrder, assertRefund } = require("../domain/payments");
const repository = require("../repositories/payments.repository");
const providerService = require("./razorpayGateway.service");
const gatewayService = require("./gateway.service");
const configService = require("./paymentsReadiness.service");
const MINUTE = 60000, DAY = 86400000;
function createPaymentRecovery({ repo = repository, provider = providerService, gateways = gatewayService, config = configService,
  native = require("./nativePayments.service"),
  now = () => new Date(), random = randomToken, newId = () => new mongoose.Types.ObjectId(),
  authorize = (ws, user) => requireWorkspacePermission(ws, "commerce.payments.manage", user) } = {}) {
  const conflict = () => new HttpError(409, "Payment recovery ownership changed. Reconciliation will retry.");
  async function resolveStock(attempt, consume, session) {
    const reservation = await repo.reservation(attempt.workspaceId, attempt._id, session);
    if (!reservation) throw conflict();
    if (reservation.status !== "held") return reservation.status;
    if (!await repo.resolveReservation(reservation, consume ? "consumed" : "released", now(), session)) throw conflict();
    for (const item of reservation.items) if (!await repo.resolveStock(attempt.workspaceId, item, consume, now(), session)) throw conflict();
    return consume ? "consumed" : "released";
  }
  async function expireReservation(ws, id) {
    return repo.transaction(async (session) => {
      const attempt = await repo.attempt(ws, id, session), reservation = await repo.reservation(ws, id, session);
      if (!attempt || !reservation || reservation.status !== "held" || new Date(reservation.expiresAt) > now()) return;
      await resolveStock(attempt, false, session);
      const order = await repo.order(ws, attempt.orderId, session);
      if (order && order.paymentStatus !== "captured" && same(order.activeAttemptId, id)
          && !await repo.transitionOrder(order, { status: "requires_attention", attentionReason: "checkout_expired_verification_pending" }, session)) throw conflict();
    });
  }
  async function terminal(attempt, status) {
    return repo.transaction(async (session) => {
      await resolveStock(attempt, false, session);
      const order = await repo.order(attempt.workspaceId, attempt.orderId, session);
      if (same(order?.activeAttemptId, attempt._id)) {
        const patch = order.paymentStatus === "captured" ? { activeAttemptId: null } : {
          activeAttemptId: null, paymentStatus: "unpaid", status: "needs_review", reviewedAt: null, reviewedBy: "", attentionReason: "" };
        if (!await repo.transitionOrder(order, patch, session)) throw conflict();
      }
      const updated = await repo.updateAttempt(attempt, { status, active: false, paymentUrl: "", lastCheckedAt: now(),
        lastError: "", nextCheckAt: new Date(now().getTime() + DAY) }, session);
      if (!updated) throw conflict();
      return updated;
    });
  }
  async function capture(attempt, link, payments, account, nextCaptureCursor, nativeEvidence) {
    return repo.transaction(async (session) => {
      let order = await repo.order(attempt.workspaceId, attempt.orderId, session);
      if (!order) throw conflict();
      let extra = false;
      for (const payment of payments) {
        if (attempt.mode === "whatsapp_native") assertNativeCapture({ ...nativeEvidence, payment, attempt, gateway: account });
        else assertCapturedPayment({ payment, attempt: { ...attempt, providerLinkId: link.id }, link,
          expectedAccountId: account?.merchantAccountId });
        const existing = await repo.payment(attempt.workspaceId, attempt.gatewayConnectionId, payment.id, session);
        if (existing) {
          if (!same(existing.attemptId, attempt._id) || existing.amountPaise !== payment.amount) throw conflict();
          continue;
        }
        const overpayment = order.paymentStatus === "captured";
        const saved = await repo.createPayment({ workspaceId: attempt.workspaceId, orderId: order._id, attemptId: attempt._id,
          gatewayConnectionId: attempt.gatewayConnectionId, environment: attempt.environment, providerPaymentId: payment.id,
          providerOrderId: payment.order_id, status: "captured", amountPaise: payment.amount, currency: "INR",
          method: typeof payment.method === "string" ? payment.method.slice(0, 50) : "", capturedAt: null,
          verifiedAt: now(), nextCheckAt: now(), overpayment, refundedPaise: payment.amount_refunded }, session);
        if (overpayment) {
          extra = true;
          order = await repo.transitionOrder(order, { status: "requires_attention", attentionReason: "extra_captured_payment_refund_review" }, session);
        } else {
          const stockState = await resolveStock(attempt, true, session);
          const late = stockState !== "consumed";
          if (order.activeAttemptId && !same(order.activeAttemptId, attempt._id)) {
            const replacement = await repo.attempt(attempt.workspaceId, order.activeAttemptId, session);
            if (replacement) {
              await repo.requestCancel(attempt.workspaceId, replacement._id, now(), session);
              await resolveStock(replacement, false, session);
            }
          }
          order = await repo.transitionOrder(order, { paidAttemptId: attempt._id, paidAt: now(), paymentStatus: "captured",
            activeAttemptId: same(order.activeAttemptId, attempt._id) ? null : order.activeAttemptId,
            status: late || payment.amount_refunded > 0 ? "requires_attention" : "confirmed",
            attentionReason: late ? "payment_after_stock_release" : payment.amount_refunded > 0 ? "payment_refunded_review" : "" }, session);
          if (!order) throw conflict();
          const notification = { _id: newId(), workspaceId: attempt.workspaceId, orderId: order._id,
            key: `payment-confirmed:${order._id}`, requestedBy: attempt.requestedBy };
          notification.payloadEnc = encryptCommerceSecret(JSON.stringify({ paymentId: String(saved._id), amountPaise: saved.amountPaise }),
            { workspaceId: notification.workspaceId, recordId: notification._id, field: "payloadEnc" });
          await repo.outbox(notification, session);
        }
        if (!order) throw conflict();
      }
      if (extra) await resolveStock(attempt, false, session);
      const updated = await repo.updateAttempt(attempt, { status: "captured", active: false, ...(link ? { providerLinkId: link.id } : {}),
        providerOrderId: payments[0].order_id, paymentUrl: "", lastCheckedAt: now(), lastError: "",
        captureCursor: nextCaptureCursor, nextCheckAt: new Date(now().getTime() + (nextCaptureCursor ? MINUTE : DAY)) }, session);
      if (!updated) throw conflict();
      return updated;
    });
  }
  async function reconcile(ws, id) {
    let attempt = await repo.claimAttempt(ws, id, random(), now());
    if (!attempt) throw conflict();
    try {
      const gateway = await repo.gateway(ws, attempt.gatewayConnectionId);
      if (!gateway || gateway.environment !== attempt.environment) fail("Original merchant connection is unavailable.");
      if (attempt.mode === "whatsapp_native") {
        if (!attempt.createStartedAt) {
          const settings = await repo.settings(ws);
          if (attempt.cancelRequestedAt || new Date(attempt.expiresAt).getTime() <= now().getTime() + 300000
              || !config.nativeAllowed(ws, attempt.nativeWabaId, attempt.nativePhoneNumberId, attempt.gatewayConnectionId)
              || !settings?.enabled || !settings.liveCheckoutEnabled || !await repo.workspaceActive(ws))
            return await terminal(attempt, attempt.cancelRequestedAt ? "cancelled" : "expired");
          await authorize(ws, attempt.requestedBy);
          await gateways.getMerchantAuthentication(ws, attempt.gatewayConnectionId, attempt.environment);
          attempt = await repo.updateAttempt(attempt, { createStartedAt: now(), status: "unknown" }, undefined, false);
          if (!attempt) throw conflict();
          await native.dispatch(attempt);
        }
        const lookup = await native.lookup(attempt);
        if (lookup.status === "captured") {
          const txn = lookup.transactions.find((t) => t.status === "success");
          const auth = await gateways.getReconciliationAuthentication(ws, attempt.gatewayConnectionId, attempt.environment);
          const raw = await provider.fetchPayment(auth, txn.pg_transaction_id);
          const payment = raw?.status === "refunded" && raw.captured === true && raw.amount_refunded === raw.amount ? { ...raw, status: "captured" } : raw;
          const providerOrder = await provider.fetchOrder(auth, txn.id);
          assertNativeCapture({ lookup, attempt, payment, providerOrder, gateway });
          return await capture(attempt, null, [payment], gateway, 0, { lookup, providerOrder });
        }
        if (attempt.status === "captured") fail("Provider returned stale native payment state.");
        const latest = await repo.attempt(ws, id), closing = latest.cancelRequestedAt || new Date(attempt.expiresAt) <= now();
        if (closing && !attempt.nativeCancelStartedAt) {
          attempt = await repo.updateAttempt(attempt, { nativeCancelStartedAt: now() }, undefined, false);
          if (!attempt) throw conflict();
          await native.cancel(attempt);
        }
        // Lookup exposes only pending/captured, not an authoritative cancellation state.
        // An accepted status message or expired local clock cannot unlock a replacement charge.
        const updated = await repo.updateAttempt(attempt, { status: closing ? "requires_attention" : "payable", paymentUrl: "",
          lastCheckedAt: now(), lastError: closing ? "native_closure_verification_pending" : "",
          nextCheckAt: new Date(now().getTime() + MINUTE), reconcileCount: attempt.reconcileCount + 1 });
        if (!updated) throw conflict();
        return updated;
      }
      let link, auth;
      if (!attempt.createStartedAt && !attempt.providerLinkId) {
        if (attempt.cancelRequestedAt || new Date(attempt.expiresAt).getTime() <= now().getTime() + MINUTE)
          return await terminal(attempt, attempt.cancelRequestedAt ? "cancelled" : "expired");
        const settings = await repo.settings(ws), order = await repo.order(ws, attempt.orderId);
        if (!config.checkoutEnabled() || !settings?.enabled || !await repo.workspaceActive(ws)
            || !same(order?.activeAttemptId, attempt._id) || order.paymentStatus === "captured")
          return await terminal(attempt, "cancelled");
        if (attempt.environment === "live" && (!config.liveEnabled() || !settings.liveCheckoutEnabled || !require("../domain/liveGateway").liveGatewayReady(gateway, attempt.mode))) return await terminal(attempt, "cancelled");
        await authorize(ws, attempt.requestedBy);
        auth = await gateways.getMerchantAuthentication(ws, attempt.gatewayConnectionId, attempt.environment);
        // Persist the irreversible boundary before POST. An abandoned create is
        // recovered only by GET(reference), regardless of the worker lease expiry.
        attempt = await repo.updateAttempt(attempt, { createStartedAt: now(), status: "unknown" }, undefined, false);
        if (!attempt) throw conflict();
        link = assertLink(await provider.createLink(auth, linkPayload(attempt)), attempt);
      } else {
        auth = await gateways.getReconciliationAuthentication(ws, attempt.gatewayConnectionId, attempt.environment);
        link = attempt.providerLinkId ? assertLink(await provider.fetchLink(auth, attempt.providerLinkId), attempt)
          : foundLink(await provider.findLink(auth, attempt.reference), attempt);
        if (!link) throw new HttpError(409, "Checkout creation is unresolved. Inspect the original merchant reference.");
      }
      const entries = link.payments || [];
      const cursor = attempt.captureCursor < entries.length ? attempt.captureCursor : 0;
      const nextCaptureCursor = cursor + 10 < entries.length ? cursor + 10 : 0;
      const payments = [];
      for (const entry of entries.slice(cursor, cursor + 10)) {
        const payment = await provider.fetchPayment(auth, entry.payment_id);
        // Full refunds preserve captured=true. A refunded payment is prior
        // capture evidence only with the exact full refund amount corroborated.
        const evidence = payment.status === "refunded" && payment.captured === true && payment.amount_refunded === payment.amount
          ? { ...payment, status: "captured" } : payment;
        if (evidence.status !== "captured" || evidence.captured !== true) continue;
        if (!Number.isSafeInteger(evidence.amount_refunded) || evidence.amount_refunded < 0 || evidence.amount_refunded > evidence.amount) fail();
        assertCapturedPayment({ payment: evidence, attempt: { ...attempt, providerLinkId: link.id }, link, expectedAccountId: gateway.merchantAccountId });
        payments.push(evidence);
      }
      if (payments.length) {
        const order = await provider.fetchOrder(auth, payments[0].order_id);
        for (const payment of payments) assertProviderOrder(order, payment, attempt);
        return await capture(attempt, link, payments, gateway, nextCaptureCursor);
      }
      if (link.status === "paid" || link.status === "partially_paid" || link.amount_paid > 0) fail("Payment-link capture is not yet fully verified.");
      if (attempt.status === "captured") fail("Provider returned stale payment state.");
      if (["expired", "cancelled"].includes(link.status)) {
        // Persist correlation before releasing; later captures must still find the attempt.
        attempt = await repo.updateAttempt(attempt, { providerLinkId: link.id }, undefined, false);
        if (!attempt) throw conflict();
        return await terminal(attempt, link.status);
      }
      const latest = await repo.attempt(ws, id);
      if (!attempt.active) fail("Closed checkout returned an inconsistent provider state.");
      if (latest.cancelRequestedAt || new Date(attempt.expiresAt) <= now()) {
        // Cancellation response is not financial evidence; fetch afresh on the next
        // pass, so a capture racing this request is processed by the same verifier.
        await provider.cancelLink(auth, link.id);
        const updated = await repo.updateAttempt(attempt, { providerLinkId: link.id, paymentUrl: "", status: "unknown", nextCheckAt: now(), lastCheckedAt: now() });
        if (!updated) throw conflict();
        return updated;
      }
      if (attempt.status === "captured") fail("Provider returned stale payment state.");
      const updated = await repo.updateAttempt(attempt, { providerLinkId: link.id, paymentUrl: paymentUrl(link), status: "payable",
        lastCheckedAt: now(), lastError: "", nextCheckAt: new Date(now().getTime() + MINUTE), reconcileCount: attempt.reconcileCount + 1 });
      if (!updated) throw conflict();
      return updated;
    } catch (error) {
      if (attempt) await repo.updateAttempt(attempt, { ...(attempt.status === "captured" ? {} : { status: "unknown", paymentUrl: "" }),
        lastError: error.authenticationRejected ? "merchant_credentials_rejected" : "payment_verification_pending",
        lastCheckedAt: now(), nextCheckAt: new Date(now().getTime() + Math.min(60, 2 ** Math.min(attempt.reconcileCount, 6)) * MINUTE),
        reconcileCount: attempt.reconcileCount + 1 }).catch(() => {});
      throw error instanceof HttpError ? error : new HttpError(503, "Payment verification is pending. Check the original merchant account.");
    } finally {
      await expireReservation(ws, id).catch(() => {});
    }
  }
  async function syncRefunds(ws, id, refundId) {
    const payment = await repo.paymentById(ws, id);
    if (!payment) throw new HttpError(404, "Verified payment not found.");
    const auth = await gateways.getReconciliationAuthentication(ws, payment.gatewayConnectionId, payment.environment);
    const evidence = await provider.fetchPayment(auth, payment.providerPaymentId);
    if (!evidence || evidence.id !== payment.providerPaymentId || evidence.order_id !== payment.providerOrderId || evidence.captured !== true
        || !["captured", "refunded"].includes(evidence.status) || evidence.amount !== payment.amountPaise || evidence.currency !== "INR"
        || !Number.isSafeInteger(evidence.amount_refunded) || evidence.amount_refunded < 0 || evidence.amount_refunded > evidence.amount) fail();
    const response = refundId ? { items: [await provider.fetchRefund(auth, refundId)] }
      : await provider.fetchRefunds(auth, payment.providerPaymentId, payment.refundCursor || 0);
    if (!Array.isArray(response?.items) || response.items.length > 25 || (!refundId && (response.entity !== "collection" || response.count !== response.items.length))) fail();
    for (const refund of response.items) assertRefund(refund, payment);
    return repo.transaction(async (session) => {
      for (const refund of response.items) {
        const existing = await repo.refund(ws, payment.gatewayConnectionId, refund.id, session);
        if (existing && (!same(existing.paymentId, payment._id) || existing.amountPaise !== refund.amount)) throw conflict();
        if (!existing) await repo.createRefund({ workspaceId: ws, paymentId: payment._id, gatewayConnectionId: payment.gatewayConnectionId,
          providerRefundId: refund.id, amountPaise: refund.amount, status: refund.status, verifiedAt: now() }, session);
        else if (existing.status === "pending" || refund.status === "processed")
          await repo.updateRefund(existing, { status: refund.status, verifiedAt: now() }, session);
      }
      if (evidence.amount_refunded > 0) {
        const order = await repo.order(ws, payment.orderId, session);
        if (order && order.status !== "requires_attention" && !await repo.transitionOrder(order,
          { status: "requires_attention", attentionReason: "payment_refunded_review" }, session)) throw conflict();
      }
      return repo.updatePayment(payment, { refundedPaise: evidence.amount_refunded, verifiedAt: now(), lastError: "",
        ...(refundId ? {} : { refundCursor: response.items.length === 25 ? (payment.refundCursor || 0) + 25 : 0 }),
        nextCheckAt: new Date(now().getTime() + (response.items.length === 25 ? MINUTE : DAY)) }, session);
    });
  }
  async function run() {
    if (!config.paymentsEnabled()) return { skipped: true };
    await config.assertPaymentsReady();
    let reconciled = 0, deferred = 0;
    for (const row of await repo.expiredReservations(now())) {
      try { await expireReservation(row.workspaceId, row.attemptId); } catch { deferred++; }
    }
    for (const row of await repo.dueAttempts(now())) {
      try { await reconcile(row.workspaceId, row._id); reconciled++; } catch { deferred++; }
    }
    for (const row of await repo.duePayments(now())) {
      try { await syncRefunds(row.workspaceId, row._id); } catch {
        deferred++;
        await repo.updatePayment(row, { lastError: "refund_verification_pending", nextCheckAt: new Date(now().getTime() + 60 * MINUTE) });
      }
    }
    return { reconciled, deferred };
  }
  return { reconcile, expireReservation, syncRefunds, run };
}
module.exports = { createPaymentRecovery, ...createPaymentRecovery() };
