const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { encryptCommerceSecret, decryptCommerceSecret } = require("./commerceSecrets.service");
const { hash, randomToken, validSignature, gatewayDto } = require("../domain/gateway");
const validators = require("../validators/payments.validators");
const repository = require("../repositories/payments.repository");
const recoveryService = require("./paymentRecovery.service");
const gatewayService = require("./gateway.service");
const providerService = require("./razorpayGateway.service");
const configService = require("./paymentsReadiness.service");
const EVENTS = new Set(["payment_link.paid", "payment_link.partially_paid", "payment_link.expired", "payment_link.cancelled",
  "payment.captured", "payment.authorized", "payment.failed", "order.paid", "refund.created", "refund.processed", "refund.failed",
  "payment.dispute.created", "payment.dispute.won", "payment.dispute.lost", "payment.dispute.closed", "payment.dispute.under_review", "payment.dispute.action_required"]);
function createPaymentWebhooks({ repo = repository, recovery = recoveryService, gateways = gatewayService, provider = providerService,
  config = configService, now = () => new Date(), random = randomToken, newId = () => new mongoose.Types.ObjectId(),
  authorize = (ws, user) => requireWorkspacePermission(ws, "commerce.gateway.manage", user) } = {}) {
  const context = (record, field) => ({ workspaceId: record.workspaceId, recordId: record._id, field });
  const open = (record, field) => decryptCommerceSecret(record[field], context(record, field));
  async function verifyManualIdentity(ws, id, userId, input) {
    const data = validators.parse(validators.identity, input), manual = await repo.gateway(ws, id);
    const trusted = await repo.gateway(ws, data.oauthGatewayConnectionId);
    if (!manual || !trusted) throw new HttpError(404, "Merchant gateway not found.");
    if (manual.authType !== "api_keys" || !manual.active || manual.status !== "connected" || manual.revision !== data.revision
        || trusted.authType !== "oauth" || !trusted.identityVerified || !trusted.merchantAccountId || trusted.status === "revoked"
        || trusted.environment !== manual.environment) throw new HttpError(409, "A verified OAuth connection in the same environment is required for account proof.");
    const manualAuth = await gateways.getMerchantAuthentication(ws, id, manual.environment);
    const oauthAuth = await gateways.getReconciliationAuthentication(ws, trusted._id, trusted.environment);
    const trustedPayment = await provider.fetchPayment(oauthAuth, data.providerPaymentId);
    const manualPayment = await provider.fetchPayment(manualAuth, data.providerPaymentId);
    if ([trustedPayment, manualPayment].some((p) => p?.entity !== "payment" || p.id !== data.providerPaymentId)
        || trustedPayment.amount !== manualPayment.amount || trustedPayment.currency !== manualPayment.currency)
      throw new HttpError(409, "API keys do not prove access to the verified merchant account.");
    await authorize(ws, userId);
    try {
      return await repo.transaction(async (session) => {
        const proof = await repo.gateway(ws, trusted._id, session);
        if (!proof || proof.status === "revoked" || proof.merchantAccountId !== trusted.merchantAccountId) throw new HttpError(409, "Merchant account proof changed.");
        const updated = await repo.updateGateway(manual, { merchantAccountId: trusted.merchantAccountId, identityVerified: true }, session);
        if (!updated) throw new HttpError(409, "Gateway changed. Retry account verification.");
        return gatewayDto(updated);
      });
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, "This verified merchant account already has an active connection.");
      throw error;
    }
  }
  async function configure(ws, id, input) {
    const { revision } = validators.parse(validators.revisionBody, input), record = await repo.gateway(ws, id);
    if (!record) throw new HttpError(404, "Merchant gateway not found.");
    if (!record.active || record.status !== "connected" || record.revision !== revision) throw new HttpError(409, "Gateway changed or is disconnected.");
    if (record.previousWebhookSecretEnc && new Date(record.previousWebhookSecretExpiresAt) > now())
      throw new HttpError(409, "Previous webhook secret is still within the retry window. Rotate after it expires.");
    const secret = random(), patch = { webhookSecretEnc: encryptCommerceSecret(secret, context(record, "webhookSecretEnc")),
      webhookStatus: "needs_setup", previousWebhookSecretEnc: "", previousWebhookSecretExpiresAt: null };
    if (record.webhookSecretEnc) {
      patch.previousWebhookSecretEnc = encryptCommerceSecret(open(record, "webhookSecretEnc"), context(record, "previousWebhookSecretEnc"));
      patch.previousWebhookSecretExpiresAt = new Date(now().getTime() + 72 * 3600000);
    }
    const updated = await repo.updateGateway(record, patch);
    if (!updated) throw new HttpError(409, "Gateway changed. Reload its status before rotating.");
    return { gateway: gatewayDto(updated), secret, webhookPath: `/api/commerce/webhooks/razorpay/${record._id}`,
      events: [...EVENTS], previousSecretExpiresAt: patch.previousWebhookSecretExpiresAt };
  }
  async function receive(id, raw, signature, eventId) {
    validators.parse(validators.objectId.required(), id);
    const gateway = await repo.webhookGateway(id);
    if (!gateway || !Buffer.isBuffer(raw) || raw.length > 256 * 1024 || !gateway.webhookSecretEnc)
      throw new HttpError(401, "Invalid merchant webhook signature.");
    const secrets = [open(gateway, "webhookSecretEnc")];
    if (gateway.previousWebhookSecretEnc && new Date(gateway.previousWebhookSecretExpiresAt) > now()) secrets.push(open(gateway, "previousWebhookSecretEnc"));
    if (!validSignature(raw, signature, secrets)) throw new HttpError(401, "Invalid merchant webhook signature.");
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "Invalid payment webhook JSON."); }
    if (!payload || payload.entity !== "event" || !/^acc_[A-Za-z0-9]{1,80}$/.test(payload.account_id || "")
        || !Number.isSafeInteger(payload.created_at) || payload.created_at <= 0 || payload.created_at > Math.floor(now().getTime() / 1000) + 300)
      throw new HttpError(400, "Invalid payment webhook envelope.");
    if (gateway.identityVerified && gateway.merchantAccountId !== payload.account_id) throw new HttpError(401, "Merchant webhook account mismatch.");
    if (!EVENTS.has(payload.event)) return { ignored: true };
    if (eventId !== undefined && (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(eventId)))
      throw new HttpError(400, "Invalid payment event identifier.");
    const event = { _id: newId(), workspaceId: gateway.workspaceId, gatewayConnectionId: gateway._id, kind: "razorpay",
      eventKey: `razorpay:${gateway._id}:${hash(eventId || raw)}`, nextAttemptAt: now() };
    const signedWithCurrent = validSignature(raw, signature, [secrets[0]]);
    event.payloadEnc = encryptCommerceSecret(JSON.stringify({ rawBody: raw.toString("utf8"),
      secretHash: hash(signedWithCurrent ? secrets[0] : secrets[1]) }), context(event, "payloadEnc"));
    await repo.persistEvent(event);
    // The worker verifies a resource under these credentials before webhook health
    // becomes verified. A signed arbitrary payload cannot establish merchant identity.
    return { accepted: true };
  }
  async function process(event) {
    const stored = JSON.parse(open(event, "payloadEnc")), payload = JSON.parse(stored.rawBody), ws = event.workspaceId;
    const gateway = await repo.gateway(ws, event.gatewayConnectionId);
    if (!gateway || (gateway.identityVerified && gateway.merchantAccountId !== payload.account_id)) throw new HttpError(409, "Merchant event identity mismatch.");
    const entities = payload.payload || {}, link = entities.payment_link?.entity;
    const refundId = entities.refund?.entity?.id;
    const paymentId = entities.payment?.entity?.id || entities.refund?.entity?.payment_id || entities.dispute?.entity?.payment_id;
    let attempt;
    if (link?.id) attempt = await repo.byLink(ws, gateway._id, link.id);
    if (!attempt && link?.reference_id) attempt = await repo.byReference(ws, gateway._id, link.reference_id);
    let payment = paymentId ? await repo.payment(ws, gateway._id, paymentId) : null;
    if (!attempt && payment) attempt = await repo.attempt(ws, payment.attemptId);
    if (!attempt && paymentId) {
      const auth = await gateways.getReconciliationAuthentication(ws, gateway._id, gateway.environment);
      const result = await provider.findLinkForPayment(auth, paymentId);
      const links = result?.id ? [result] : result?.payment_links;
      if (!Array.isArray(links) || links.length > 1) throw new HttpError(409, "Payment checkout correlation is unresolved.");
      if (links[0]?.reference_id) attempt = await repo.byReference(ws, gateway._id, links[0].reference_id);
    }
    // A merchant account can also receive non-Commerce sales. A fetched resource
    // can prove webhook health without importing the sale or inferring identity.
    if (!attempt) {
      if (!paymentId) return;
      const auth = await gateways.getReconciliationAuthentication(ws, gateway._id, gateway.environment);
      const evidence = await provider.fetchPayment(auth, paymentId);
      if (evidence?.id !== paymentId || evidence.entity !== "payment") throw new HttpError(409, "Merchant webhook resource verification failed.");
      await markHealthy(gateway, stored.secretHash);
      return;
    }
    if (attempt.environment !== gateway.environment) throw new HttpError(409, "Merchant event environment mismatch.");
    await recovery.reconcile(ws, attempt._id);
    if (paymentId) payment = await repo.payment(ws, gateway._id, paymentId);
    if (refundId) {
      if (!payment) throw new HttpError(409, "Refund is waiting for verified capture.");
      await recovery.syncRefunds(ws, payment._id, refundId);
    }
    if (payload.event.startsWith("payment.dispute.") && payment) {
      // A signed dispute triggers review, never a refund or payment-state rewrite.
      await repo.transaction(async (session) => {
        const order = await repo.order(ws, attempt.orderId, session);
        if (!order || !await repo.transitionOrder(order, { status: "requires_attention", attentionReason: "merchant_payment_dispute_review" }, session))
          throw new HttpError(409, "Dispute review update requires retry.");
      });
    }
    await markHealthy(gateway, stored.secretHash);
  }
  async function markHealthy(gateway, secretHash) {
    const fresh = await repo.gateway(gateway.workspaceId, gateway._id);
    if (fresh?.webhookSecretEnc && hash(open(fresh, "webhookSecretEnc")) === secretHash)
      await repo.updateGateway(fresh, { webhookStatus: "verified", lastWebhookAt: now() });
  }
  async function run() {
    if (!config.paymentsEnabled()) return { skipped: true };
    await config.assertPaymentsReady();
    let processed = 0, deferred = 0;
    for (const row of await repo.eventCandidates(now())) {
      const event = await repo.claimEvent(row.workspaceId, row._id, random(), now());
      if (!event) continue;
      try { await process(event); await repo.finishEvent(event, { status: "processed", processedAt: now(), lastError: "" }); processed++; }
      catch {
        await repo.finishEvent(event, { status: event.attempts >= 5 ? "dead_letter" : "pending", lastError: "merchant_event_verification_pending",
          nextAttemptAt: new Date(now().getTime() + 2 ** Math.min(event.attempts, 5) * 60000) });
        deferred++;
      }
    }
    return { processed, deferred };
  }
  return { configure, verifyManualIdentity, receive, process, run };
}
module.exports = { EVENTS, createPaymentWebhooks, ...createPaymentWebhooks() };
