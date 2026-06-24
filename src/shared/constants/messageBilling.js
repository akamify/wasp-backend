const META_BILLING_OWNER = "platform_or_connected_waba";
const META_BILLING_HANDLED_BY = "Meta billing hub / WABA billing";

const MESSAGE_CHARGE_SOURCE = Object.freeze({
  WALLET: "wallet",
  FREE_SERVICE_WINDOW: "free_service_window",
  NONE: "none",
});

module.exports = { META_BILLING_OWNER, META_BILLING_HANDLED_BY, MESSAGE_CHARGE_SOURCE };
