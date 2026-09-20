# Stage 7: merchant-owned native WhatsApp payments

Implemented locally on 2026-09-15. **Production activation is pending real-account and infrastructure acceptance.** Hosted Payment Links remain the default. Manual API keys and OAuth still use each workspace's own Razorpay connection; platform wallet/billing credentials are never used for customer-sale checkout.

## Verified contracts

Reviewed the current official sources before implementation:

- [Meta: payments through payment gateways in India](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-in/pg): `order_details`, physical-goods beneficiaries, integer amounts with offset 100, expiration, payment lookup and `order_status`. The official `.md` representation was used when the rendered page was unavailable.
- [Meta: payment configuration onboarding APIs](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-in/onboarding-apis): configuration lookup, `Active` status, `provider_name` and `provider_mid`.
- [Razorpay: WhatsApp integration](https://razorpay.com/docs/payments/whatsapp/integrate/): merchant-to-Meta linkage is separate from merchant-to-AIWizChat OAuth.
- [GitHub setup-node](https://github.com/actions/setup-node) and [checkout](https://github.com/actions/checkout): verification workflow setup.

The payment lookup returns `pending` or `captured`; failed transaction attempts can exist under a pending payment. A webhook or delivered message is not capture evidence. The implementation requires a matching Meta lookup **and** Razorpay payment/order fetched using the attempt's original merchant credentials.

## Merchant setup and checkout

1. Complete the existing catalog, order and merchant gateway setup. Manual and OAuth connections both work after trusted merchant identity verification. Native checkout requires a live connection, verified payment webhook and all live checkout gates.
2. In WhatsApp Manager, connect the merchant's own Razorpay account under Payment configurations. Complete Meta's authorization/testing requirements. AIWizChat does not create an OAuth link on the merchant's behalf in this increment.
3. In Commerce Settings, expand **Native WhatsApp payments**, enter the exact configuration name and select **Verify native configuration**. `POST /api/commerce/gateways/:gatewayId/native` accepts only `{revision, configurationName}`. Backend verification requires one exact active Razorpay configuration whose `provider_mid` matches the already verified merchant account ID. Client-supplied eligibility/identity fields are rejected.
4. An operator can allow a controlled pilot using the flags below. Configuration verification alone does not claim that an end-to-end payment test passed.
5. Review a live order. Operators with payment/order management, Commerce message sending and inbox reply permissions can select **Native WhatsApp Review and Pay**. Creating this request sends the interactive message automatically. A current customer service window is required.

The existing payment-request API accepts an optional `mode`: `razorpay_payment_link` (default) or `whatsapp_native`. Mode is included in the idempotency fingerprint. Caller-supplied amounts, provider bodies and payment status remain prohibited.

Native V1 deliberately supports live India/INR physical catalog orders only, up to INR 500,000. Test orders and larger totals use hosted Payment Links. Native reservations must be at least six minutes, leaving time for Meta's minimum five-minute expiration threshold. Delivery needs a complete Indian address and address lines within Meta's 100-character limit. The complete UTF-8 message is bounded before reservation; no silent address/product loss is used to make an oversized message fit.

The message uses the reviewed tax-inclusive unit prices. Its additional tax field is zero with an explanation that tax is included; the stored included-tax amounts are not rewritten. Product subtotal plus delivery equals the exact checkout amount. Beneficiaries go to Meta when required; their plaintext is removed from persisted inbox interactive payloads. The original address remains encrypted in the order.

## Recovery and notification behavior

- Attempts snapshot the original configuration, WABA, phone and verified merchant account. These four additive fields are immutable. `nativeCancelStartedAt` records cancellation dispatch intent. No new collection, index or database migration is introduced by Stage 7.
- Fresh native checkout verifies the Meta configuration, current channel, operator permissions, message window, live gates, quote, inventory and merchant revision. Stock reservation and checkout/order changes use the existing transaction and revision guards.
- The create boundary is persisted before native dispatch. After timeout, restart or ambiguous failure, recovery only looks up the same reference; it never retries the native create or falls back to a new hosted charge.
- Signed Meta payment callbacks durably bring forward the matching attempt's reconciliation time before acknowledgement. Matching requires the globally unique reference and both original asset IDs. Raw-body signature validation is mandatory. Callback status/amount never changes financial state, and payment callbacks are excluded from legacy message-delivery status handling.
- The existing worker processes native attempts alongside hosted attempts. Recovery remains enabled when new/native checkout switches are turned off. Lookup uses the immutable configuration; changing the configured gateway name does not move historical checkout.
- Captured funds, stock consumption, order confirmation and the confirmation outbox commit together. Refunds use the existing merchant-scoped Razorpay verifier. Late payment and pre-existing refunds require fulfillment review. Captured payment is not a bank-settlement claim.
- Native confirmation and fulfillment changes use `order_status` messages through the existing durable sender/outbox. Processing, shipped and completed are derived from authoritative fulfillment state. A blocked permission/window/channel keeps the notification blocked; uncertain dispatch is not automatically resent. Neither condition reverses payment.

**Cancellation limitation:** Meta's documented payment lookup does not expose an authoritative canceled/expired terminal state. A cancellation/expiry can send one `canceled` status update, but an accepted message or pending lookup never releases the active checkout for a replacement charge. Such attempts remain `requires_attention` with `native_closure_verification_pending`. Inventory reservations still expire on schedule, and a later capture is recorded for stock/refund review. There is no force-close endpoint in this increment. Resolve these cases against the original merchant/Meta records; do not manually clear attempts or create another charge based on a screenshot. This conservative behavior needs explicit pilot acceptance before rollout.

## Activation and rollback

Existing Commerce catalog/order/gateway/payments and live settings must already be operational. New native settings are off/empty unless an operator supplies them:

```text
COMMERCE_NATIVE_PAYMENTS_ENABLED=false
COMMERCE_NATIVE_ACCEPTED_BINDINGS=
```

For a reviewed pilot only, enable the native flag and set the comma-separated exact allowlist:

```text
COMMERCE_NATIVE_ACCEPTED_BINDINGS=<workspaceId>:<wabaId>:<phoneNumberId>:<gatewayConnectionId>
```

All of `COMMERCE_PAYMENTS_ENABLED`, `COMMERCE_CHECKOUT_ENABLED`, `COMMERCE_LIVE_CHECKOUT_ENABLED`, workspace `enabled`/`liveCheckoutEnabled` and the native switch are required. The allowlist contains asset/record IDs, not credentials. No flags, credentials, live accounts or database indexes were changed during implementation.

For rollback, turn off native/new-checkout switches while keeping payment processing and the Stage 7 recovery worker running. Retain the original Meta and merchant authorization needed for outstanding attempts. Do not roll back to an older recovery implementation while native attempts remain unresolved. A changed/revoked original channel blocks verification visibly instead of substituting another channel or merchant.

## Files changed in this increment

Backend:

- `src/infra/database/CommerceCheckoutAttempt.js`
- `src/modules/commerce/domain/nativePayments.js`, `payments.js`, `gateway.js`
- `src/modules/commerce/services/nativePayments.service.js`, `metaNativePayments.service.js`, `nativePaymentWebhooks.service.js`
- `src/modules/commerce/services/payments.service.js`, `paymentRecovery.service.js`, `paymentOutbox.service.js`, `paymentsReadiness.service.js`, `operations.service.js`
- `src/modules/commerce/repositories/payments.repository.js`
- `src/modules/commerce/validators/payments.validators.js`
- `src/modules/commerce/routes/gateway.routes.js`, `operations.routes.js`
- `src/modules/webhooks/controllers/webhook.controller.js`
- `src/shared/services/outboundMessageService.js`
- `src/modules/commerce/tests/native-payments.test.cjs`, `gateway-routes.test.cjs`, `operations.test.cjs`, `payments-contracts.test.cjs`
- `.github/workflows/deploy.yml`, this report, `docs/commerce-stage-1.md`

Frontend:

- `src/modules/commerce/SettingsPage.tsx`, `OrdersPage.tsx`, `types.ts`
- `src/modules/conversations/components/MessageContent.tsx`
- `tests/commerce-render.test.mjs`
- `.github/workflows/deploy.yml`

Existing Stage 1–6 work and unrelated user changes remain in the working trees. No dependency was added. The native path reuses the existing payment worker; its registration did not need a Stage 7 edit.

## Verification and release status

Local checks:

- Backend Commerce suite: **203 passed**, including HTTP permission tests and native concurrency, provider mismatch, refund, expiry and timeout cases.
- Frontend Commerce tests: **19 passed**, including native permission/live-mode controls and configuration setup.
- JavaScript syntax: **112 files passed** using `node --check` from PowerShell. A first Node child-process wrapper was blocked by Windows `EPERM`; the direct checks succeeded.
- Frontend `npm run build`: **passed**, including TypeScript checking. Vite required the existing approved Windows process-access retry after sandbox `spawn EPERM`.
- Existing CSS gradient and large main-bundle warnings remain. Commerce stays lazy-loaded, approximately 42 KB / 11 KB gzip.
- Backend build: existing no-op script passed. Executable lint tooling is not configured; no lint success is claimed.
- Offline index plan: 12 collections / 43 declared indexes; no database connection or index apply.
- Both workflow YAML files parse and require `verify` before the existing deployment job; PR runs do not execute deployment. GitHub-hosted execution has not been run here.

Browser automation was attempted but failed before executing: `codex/sandbox-state-meta: missing field sandboxPolicy`. The frontend coverage is rendered-component/API-scope coverage, not interactive browser acceptance.

**Still required before production:** dedicated MongoDB replica-set/Redis integration tests; an actual browser checkout/fulfillment run; two separate live merchant accounts proving payment ownership; native configuration and delivery acceptance on the intended Graph version; success/failure/expiry/refund/revocation tests; review of uncertain cancellation operations; and successful CI on the deployment commit. Existing remote deployment scripts were not executed or independently validated.

**GO for controlled staging/pilot acceptance. NO-GO for production activation until those checks pass.** No deployment, live payment or WhatsApp message was performed.
