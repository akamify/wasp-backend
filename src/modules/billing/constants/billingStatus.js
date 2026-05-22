const BILLING_CHECKOUT_STATUS = Object.freeze({
  CREATED: "created",
  PAYMENT_PENDING: "payment_pending",
  PAID: "paid",
  FAILED: "failed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
});

const BILLING_SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  SUSPENDED: "suspended",
});

const BILLING_INVOICE_STATUS = Object.freeze({
  GENERATED: "generated",
  GENERATED_PENDING_PDF: "generated_pending_pdf",
  PDF_FAILED: "pdf_failed",
  EMAILED: "emailed",
  EMAIL_FAILED: "email_failed",
  CANCELLED: "cancelled",
  VOID: "void",
});

module.exports = {
  BILLING_CHECKOUT_STATUS,
  BILLING_SUBSCRIPTION_STATUS,
  BILLING_INVOICE_STATUS,
};

