// API-key authentication scopes Razorpay resources to the merchant. It does not
// establish the account ID required for Meta native payments.
function liveGatewayReady(gateway, mode) {
  if (!["razorpay_payment_link", "whatsapp_native"].includes(mode)) return false;
  if (!gateway?.active || gateway.status !== "connected" || gateway.environment !== "live"
      || !gateway.credentialsVerifiedAt || !gateway.webhookSecretEnc) return false;
  if (mode === "razorpay_payment_link" && gateway.authType === "api_keys") {
    // Permit the first hosted payment before a signed event establishes webhook
    // health. Capture still requires provider-fetched payment/link correlation.
    return ["needs_setup", "verified"].includes(gateway.webhookStatus);
  }
  return ["api_keys", "oauth"].includes(gateway.authType) && gateway.identityVerified === true
    && Boolean(gateway.merchantAccountId) && gateway.webhookStatus === "verified";
}
module.exports = { liveGatewayReady };
