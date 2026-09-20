const { HttpError } = require("@shared/utils/httpError");
const { verifyMetaSignature } = require("@core/middleware/webhookSignature");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const repository = require("../repositories/payments.repository");
const configService = require("./paymentsReadiness.service");
function paymentSignals(body) {
  return (Array.isArray(body?.entry) ? body.entry : []).flatMap((entry) =>
    (Array.isArray(entry.changes) ? entry.changes : []).filter((c) => c.field === "messages" && c.value?.messaging_product === "whatsapp")
      .flatMap((c) => (Array.isArray(c.value.statuses) ? c.value.statuses : []).filter((s) => s?.type === "payment")
        .map((s) => ({ wabaId: entry.id, phoneNumberId: c.value.metadata?.phone_number_id, reference: s.payment?.reference_id }))));
}
function createNativeWebhooks({ repo = repository, config = configService, signingSecret = () => getMetaAppConfig().metaAppSecret, now = () => new Date() } = {}) {
  async function receive({ body, rawBody, signature }) {
    if (!config.paymentsEnabled() || !paymentSignals(body).length) return { skipped: true };
    if (!verifyMetaSignature({ rawBody, signature, secret: signingSecret() })) throw new HttpError(401, "Commerce requires a valid Meta webhook signature.");
    const authenticated = JSON.parse(rawBody.toString("utf8"));
    if (authenticated.object !== "whatsapp_business_account") return { skipped: true };
    await config.assertPaymentsReady();
    const seen = new Set();
    for (const signal of paymentSignals(authenticated)) {
      if (!/^\d{1,30}$/.test(signal.wabaId || "") || !/^\d{1,30}$/.test(signal.phoneNumberId || "") || !/^awc_[a-f0-9]{24}$/.test(signal.reference || "")) continue;
      const key = JSON.stringify(signal); if (seen.has(key)) continue; seen.add(key);
      // Durable, idempotent wake-up before ACK. No webhook amount/status is capture evidence.
      await repo.scheduleNative(signal.reference, signal.wabaId, signal.phoneNumberId, now());
    }
    return { scheduled: seen.size };
  }
  return { receive };
}
module.exports = { paymentSignals, createNativeWebhooks, ...createNativeWebhooks() };
