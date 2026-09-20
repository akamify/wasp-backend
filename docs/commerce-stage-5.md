# Merchant-owned Commerce: Stage 5

Updated: 2026-09-10. Stage 5 backend implementation is complete locally. This is a hosted Razorpay Payment Link release increment; the Commerce dashboard/inbox UI remains Stage 6 and native WhatsApp payment eligibility remains Stage 7. Production activation has not been performed.

## Result and scope

**Result: PASS for local implementation and automated checks. GO for Stage 6. NO-GO for production payment activation.**

Stage 4 could receive carts and review quotes, but could not execute merchant checkout, reserve/consume inventory, verify captures, synchronize refunds or recover uncertain provider requests. Stage 5 adds those flows to the existing Commerce module and webhook worker, using the merchant connection stored on each attempt. It adds no package dependency, microservice or platform billing fallback.

## Checkout and stock

- `POST /orders/:orderId/payment-requests` accepts only the reviewed order revision, merchant gateway connection ID and an idempotency key of 16–100 URL-safe characters. The server supplies the amount, INR currency, reference and expiry. Minimum payable total is 100 paise.
- The same workspace/key/payload returns the existing attempt. A changed payload conflicts. The database also enforces one active attempt per order and a unique provider reference/link mapping.
- The service rechecks workspace, original WABA/phone/catalog binding, fulfillment, product revisions, current local prices, confirmed tax, available quantity, gateway environment and live gates. A disconnected channel or stale quote requires review again.
- A MongoDB snapshot transaction freezes the reviewed order, conditionally reserves all tracked products, creates a reservation and attempt, and transitions the order to `awaiting_payment`. Gateway and product revision writes fence concurrent changes. External provider calls are outside the transaction.
- Reservation duration is configurable between 5 and 120 minutes, default 30. Product stock changes queue catalog synchronization. Untracked products participate in quote concurrency checks without quantity deduction.
- Standard Payment Links explicitly disable partial payments, provider SMS/email notifications and reminders. No callback or client-submitted payment success can confirm the order.
- A durable `createStartedAt` marker precedes the provider POST. If the response is lost or a worker crashes, subsequent workers only look up the original reference. They never automatically issue another POST for that attempt.
- A lease plus revision prevents a stale worker from committing financial changes. A newly requested cancellation hides the URL immediately; provider cancellation is followed by fresh reconciliation before terminal release.
- Expired stock can be released even when provider verification is unavailable. The unresolved attempt remains active and blocks replacement checkout. A verified expired/cancelled link releases the attempt and sends the unpaid order back for fresh review.

## Financial verification and recovery

The verifier fetches the link, individual payment and provider order using the attempt's original merchant credentials. It verifies reference/link/order/payment correlation, exact INR amount and captured status. Authorization, a webhook claim, a redirect and WhatsApp delivery are not proof of payment.

Payment, order, reservation and confirmation outbox writes commit together. Repeated events and reconciliation cannot consume stock or create a payment twice. Captured payment timestamps are not invented: `capturedAt` remains null when the provider response does not supply that timestamp; `verifiedAt` and the order's `paidAt` describe local verification.

Late capture after reservation release records the money as captured, retains stock release and marks fulfillment `requires_attention`. If an expired attempt pays after a replacement was created, the replacement reservation is released and its cancellation is requested. Extra captured payments get separate records with `overpayment=true` and a refund-review attention reason.

Dashboard refunds are read and synchronized; AIWizChat does not execute refund API mutations. Payment totals use a monotonic maximum for verified refunded amount. Processed refunds cannot become pending/failed through delayed delivery. Refunds never replenish inventory or rewrite captured payment to unpaid. A verified refund places fulfillment under review, including a full refund discovered before the first capture confirmation. A fetched `refunded` payment is treated as prior capture evidence only with `captured=true` and the exact full refund amount.

Signed dispute events with a correlated verified payment create merchant attention. They do not calculate a loss, settle a dispute or change refund/payment totals.

The existing BullMQ webhook queue schedules `commerce.payments.recover` every minute. Each pass handles at most 25 expired reservations, 20 attempts, 10 payment refund scans, 20 events and 20 notifications. Each link verification fetches at most 10 payments, continuing via a persisted cursor; link responses are bounded to 100 payment entries. Refund scans fetch 25 entries per page and restart after the final page so late updates are revisited. Payable attempts normally poll every minute; verification errors back off up to an hour. Closed/captured attempts and completed refund scans are revisited daily for missed events. These are bounded batches, not a guaranteed one-minute processing latency under a backlog or slow provider.

Payment events have five automatic processing attempts, then visible `dead_letter` status and a permission-controlled retry API. Persistent reconciliation failures retain safe error codes on attempt/payment records. Database persistence is independent of Redis enqueue success; the periodic worker discovers pending records after recovery.

## Merchant keys, OAuth and live account proof

Both Manual API Keys and OAuth are supported for provider requests. An active connection is required for a new checkout. Historical reconciliation uses only the original connection; a local disconnect can still permit read-only verification using those preserved credentials. Revoked OAuth is rejected. A disconnected OAuth grant is not refreshed automatically and becomes unavailable at token expiry. Reconnecting a different gateway never reassigns old transactions.

**Manual-key account verification is deliberately separate from the credential probe.** A successful payment-list probe and a merchant-known webhook secret cannot prove an account ID. Test checkout can use an unverified manual connection, but live checkout requires verified account identity and active-account uniqueness.

For a manual connection, `/payments/gateways/:gatewayId/verify-identity` verifies the same existing provider payment under both the manual keys and an already identity-verified OAuth connection belonging to the same workspace/environment. It takes `revision`, `oauthGatewayConnectionId` and `providerPaymentId`. The account ID comes from the earlier provider OAuth token response; the request cannot supply an arbitrary account ID. A historical, locally disconnected OAuth connection can provide this proof while its token is still valid. Account collisions and permission loss fail closed. Native payment status is not enabled by this proof.

This means manual test onboarding works without partner OAuth, but manual **live** activation currently needs valid verified OAuth history for the account proof. No undocumented account-identity endpoint, client assertion or operator bypass is implemented. If that prerequisite is unavailable, live manual checkout remains blocked. A merchant can continue using its verified OAuth connection directly instead.

## Raw payment webhooks and secret rotation

`POST /api/commerce/webhooks/razorpay/:gatewayId` and the root alias accept uncompressed JSON as exact raw bytes, up to 256 KiB, before global JSON parsing. Case-insensitive Express aliases are covered. HMAC-SHA256 uses constant-time comparison. Workspace/environment come from the stored connection; webhook notes cannot route a tenant. A known verified merchant account must match the signed envelope's account ID.

Configure the merchant Dashboard webhook using the URL and one-time secret returned by `POST /payments/gateways/:gatewayId/webhook` with the current gateway `revision`. The encrypted secret is bound to its workspace, connection and field. Rotation re-encrypts the previous secret in its own field and accepts it for 72 hours; another overlapping rotation is refused. Copy the generated secret into the matching merchant/environment Dashboard and store it safely at setup time.

The supported payment-link, payment, order, refund and dispute subscriptions are returned by the configuration endpoint. A successful durable encrypted event write precedes HTTP acknowledgement; a persistence failure returns an error for provider retry. Event deduplication uses the connection plus hashed Razorpay event ID, with a raw-body hash fallback when the header is absent.

Webhook health becomes `verified` only after worker-side resource verification under the stored credentials. An authenticated, fetched non-Commerce payment can establish delivery health without importing that sale. Old-secret deliveries cannot verify a newly rotated secret. Health verification does not infer merchant identity.

## Confirmation notifications

The transaction creates one encrypted payment-confirmation outbox entry per order. The worker rechecks current message permission, active workspace and the order's original channel. The shared sender receives an optional Commerce binding constraint and checks the exact WABA/phone and current customer service window before dispatch. Existing callers do not supply this constraint.

Successful notification records the WhatsApp message ID. A timeout or abandoned send is `unknown` and is not blindly resent. Channel, permission or window failures remain visible as `blocked`; they never change a captured payment to unpaid. No approved-template fallback or customer payment-request message composer is introduced in this increment; those presentation/messaging operations belong to Stage 6. The checkout API returns the hosted link for that integration.

## HTTP contract

Paths below are relative to `/api/commerce`; `/commerce` also works. Except the signed webhook, APIs require the existing authentication and active workspace membership. Reads need `commerce.payments.view`, mutations need `commerce.payments.manage`, checkout also needs `commerce.orders.manage`, and gateway setup/identity operations need `commerce.gateway.manage`. JSON mutation validation rejects unknown authority fields. Responses are `no-store`; parser/provider failures are sanitized. Audit events omit credentials and raw customer/provider payloads.

| Method/path | Behavior |
| --- | --- |
| POST /orders/:orderId/payment-requests | Idempotent checkout request; 202 with current attempt |
| GET /orders/:orderId/payment-requests | Paginated attempts for the order and explicit environment |
| POST /orders/:orderId/reconcile | Reconcile the active or paid attempt |
| GET /orders/:orderId/notifications | Paginated notification states |
| GET /payments/attempts/:attemptId | Scoped attempt and usable hosted URL, if any |
| POST /payments/attempts/:attemptId/cancel | Persist cancel intent and attempt reconciliation |
| GET /payments | Paginated verified payments; explicit test/live environment |
| GET /payments/:paymentId/refunds | Payment and paginated verified refund records |
| GET, PATCH /payments/settings | Live workspace gate and reservation lifetime with revision check |
| POST /payments/gateways/:gatewayId/webhook | One-time webhook secret setup/rotation |
| POST /payments/gateways/:gatewayId/verify-identity | Manual account proof using verified OAuth history |
| GET /payments/events | Paginated event states; defaults to dead letters |
| POST /payments/events/:eventId/retry | Reset a dead-letter event for bounded retries |
| POST /webhooks/razorpay/:gatewayId | Public raw signed merchant event intake |

Payment, attempt, refund and notification lists require `environment=test` or `live`, use an ObjectId cursor and default to 25 rows, maximum 100. Event lists use status rather than environment and contain only safe event metadata. An order retains its original environment.

## Configuration and rollout

No environment file, external account, database index or deployment was changed in this session.

1. Prepare an isolated staging MongoDB replica set/sharded cluster and Redis. Review the offline manifest with `node scripts/commerce-indexes.cjs --plan`: **12 collections, 42 indexes**. Five indexes were added in Stage 5; apply/check only against an explicitly selected staging database using the existing operator script. Startup does not apply them.
2. Configure the existing 32-byte base64 `CREDENTIALS_ENCRYPTION_KEY`. Retain previous Commerce catalog/order/gateway configuration required by the staged workflow.
3. Set `COMMERCE_PAYMENTS_ENABLED=true` for API and worker to enable durable payment intake/recovery. Set `COMMERCE_CHECKOUT_ENABLED=true` to permit new checkout. Both default off. Gateway onboarding/new authentication continues to require `COMMERCE_GATEWAY_ENABLED=true`; OAuth also uses its existing dedicated partner configuration.
4. Configure and verify the merchant's payment webhook. Test mode permits the first checkout after the secret is configured; a corroborated real event then verifies health. Live webhook bootstrap can use an existing merchant payment event fetched with the live connection; a fictitious Dashboard test payload alone does not prove resource ownership.
5. Live checkout additionally requires `COMMERCE_LIVE_CHECKOUT_ENABLED=true`, workspace `liveCheckoutEnabled=true`, a verified webhook and verified account identity. A gateway connection or manual credential probe alone cannot turn it on.
6. Use a dedicated staging workspace/catalog for test transactions. Test/live orders and gateways are separated, but the workspace product inventory is shared: test checkouts exercise the same reservation/consumption code and must not be run against production stock unintentionally.
7. Verify two merchant accounts, duplicate/late events, last-unit concurrency, provider timeout after success, local disconnect/revocation, partial/full refunds and notification window failure against real sandbox assets. Verify database failover and Redis scheduler recovery. Inspect actual database query plans and load/backlog latency before pilot rollout.

For rollback, turn off `COMMERCE_CHECKOUT_ENABLED` and/or the live gate; **leave payment recovery and its worker enabled** to continue resolving payments/refunds. Do not disable `COMMERCE_PAYMENTS_ENABLED`, remove historical credentials or change the encryption key as a new-checkout rollback procedure.

## Verification and limitations

- **167/167 Commerce tests passed**, including 42 Stage 5 tests and all Stage 1–4 regressions. Coverage includes real HTTP middleware with simulated persistence/provider adapters, tenant and environment isolation, quote/stock concurrency, transaction rollback, duplicate/ambiguous creation, expiry/cancel/capture races, late replacement payments, extra capture batches, refund ordering, raw signatures, secret rotation, dead letters, manual identity proof and historical OAuth limits.
- Test command: `node --test --experimental-test-isolation=none src/modules/commerce/tests/*.test.cjs` on Node 22.14. The no-isolation option accommodates the existing Windows sandbox child-process restriction.
- JavaScript syntax checks, offline index planning and `git diff --check` passed. The backend `npm run build` passed and remains an existing no-op. Backend typecheck/lint scripts are not configured. Frontend was not changed or rebuilt; the user's existing LandingNavbar edit remains intact.
- Database transactions/concurrency in automated service tests are simulated; query-contract tests inspect filters, sessions, leases and write concerns. No actual MongoDB replica-set/failover execution, query execution plan, Redis integration, Razorpay sandbox/live call, WhatsApp send or deployment was performed here. These are explicit production release gates, not claimed test results.
- Provider/dashboard edits to a checkout's frozen reference, amount, partial-payment setting or expiry cause verification to fail closed. Unknown creation without a discoverable provider reference remains blocked for operator inspection, even after stock release. More than 100 reported payment entries requires inspection rather than unbounded processing.
- Disconnected/expired/revoked historical OAuth cannot be silently repaired by another merchant connection. Unresolved records remain visible; provider/account recovery may be needed. Notification retry/template UI and native WhatsApp checkout are later-stage work.
- Payment captured means the provider confirmed a payment; it does not mean bank settlement completed. Settlement, platform fees and tax invoice generation are not implemented here.

## Stage 5 files

- New domain/validation/repository: `src/modules/commerce/domain/payments.js`, `validators/payments.validators.js`, `repositories/payments.repository.js`.
- New services: `payments.service.js`, `paymentsReadiness.service.js`, `paymentRecovery.service.js`, `paymentWebhooks.service.js`, `paymentOutbox.service.js`, `commerceMessagePolicy.service.js` under `src/modules/commerce/services`.
- New HTTP files: `controllers/payments.controller.js`, `routes/payments.routes.js`, `routes/paymentsHttp.js`.
- New tests: `tests/payments-fixture.cjs`, `payments-service.test.cjs`, `payments-webhooks.test.cjs`, `payments-contracts.test.cjs`, `payments-routes.test.cjs`.
- Extended gateway files: `services/gateway.service.js`, `services/razorpayGateway.service.js`, `domain/gateway.js`, `tests/gateway-service.test.cjs`.
- Additive schema/index fields: `src/infra/database/CommerceCheckoutAttempt.js`, `CommercePayment.js`, `CommerceRefund.js`, `CommerceOutbox.js`.
- Runtime wiring: `app.js`, `src/core/routes/registerRoutes.js`, `src/infra/workers/webhook.worker.js`, `src/shared/services/outboundMessageService.js`.
- This report and the Stage 1 progress table.

## Official provider references reviewed

- [Create standard Payment Links](https://razorpay.com/docs/api/payments/payment-links/create-standard/): integer amount, explicit currency, partial-payment flag, unique reference, expiry and notification options.
- [Fetch a Payment Link](https://razorpay.com/docs/api/payments/payment-links/fetch-id-standard/?preferred-country=US): fetched link reference, linked order and captured payment IDs.
- [Razorpay's published Payment Link API reference](https://d6xcmfyh68wv8.cloudfront.net/docs/api/payments/payment-links/): reference/payment ID lookups, response shapes and cancellation.
- [Razorpay webhook FAQs](https://razorpay.com/docs/webhooks/faqs/?preferred-country=US): exact raw request bytes, event IDs, retries and ordering.
- [Fetch a refund](https://razorpay.com/docs/api/refunds/fetch-with-id/?preferred-country=US): refund payment ID, amount and lifecycle states.
- [Razorpay's official API collection](https://www.postman.com/razorpaydev/razorpay-public-workspace/documentation/mfu7vaw/razorpay-apis): payment/refund fetch endpoints.
- [OAuth integration and token lifecycle](https://razorpay.com/docs/partners/technology-partners/onboard-businesses/integrate-oauth/integration-steps/?preferred-country=IN): provider account identity, explicit environment and rotating token lifecycle.

The manual identity bridge is an application design using two authenticated resource reads and an already trusted OAuth identity; it is not a claimed Razorpay account-verification API. Documentation review and mocked contract tests do not establish that a particular merchant account has access to every endpoint.
