const { HttpError } = require("@shared/utils/httpError");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function isCustomerServiceWindowOpen({ lastInboundAt, now = new Date() }) {
  if (!lastInboundAt) return false;
  const inboundTime = new Date(lastInboundAt).getTime();
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(inboundTime) || !Number.isFinite(nowTime)) return false;
  const elapsed = nowTime - inboundTime;
  return elapsed >= 0 && elapsed <= CUSTOMER_SERVICE_WINDOW_MS;
}

function checkCustomerServiceWindow({
  contact,
  now = new Date(),
  sendType,
  businessInitiated,
}) {
  const lastInboundAt = contact?.lastInboundAt || null;
  const windowOpen =
    businessInitiated !== true ||
    isCustomerServiceWindowOpen({ lastInboundAt, now });
  process.stdout.write(
    `[WHATSAPP_WINDOW_CHECK] ${JSON.stringify({
      contactId: contact?._id ? String(contact._id) : null,
      lastInboundAt,
      windowOpen,
      sendType,
      businessInitiated: businessInitiated === true,
    })}\n`
  );
  return { windowOpen, lastInboundAt };
}

function assertFreeformSendAllowed(options) {
  const result = checkCustomerServiceWindow(options);
  if (result.windowOpen) return result;
  process.stdout.write(
    `[WHATSAPP_FREEFORM_BLOCKED_OUTSIDE_WINDOW] ${JSON.stringify({
      contactId: options.contact?._id
        ? String(options.contact._id)
        : null,
      lastInboundAt: result.lastInboundAt,
      sendType: options.sendType,
      businessInitiated: true,
    })}\n`
  );
  throw new HttpError(
    409,
    "Free-form WhatsApp message blocked outside the customer service window",
    { code: "WHATSAPP_CUSTOMER_WINDOW_CLOSED" }
  );
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  isCustomerServiceWindowOpen,
  checkCustomerServiceWindow,
  assertFreeformSendAllowed,
};
