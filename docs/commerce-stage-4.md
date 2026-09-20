# Merchant-owned Commerce: Stage 4

Updated: 2026-09-10. **Stage 4 backend is complete locally:** WhatsApp cart intake, merchant order review and fulfillment details. Payment requests, stock reservations and payment verification remain Stage 5; dashboard/inbox and customer-form presentation remain Stage 6.

## Problem and resulting behavior

Previously, incoming WhatsApp orders reached the existing inbox flow but did not create Commerce orders. There were no executable merchant review or fulfillment-detail APIs.

The webhook receiver now persists Commerce cart events before legacy message processing and inbox duplicate checks. The existing inbox/flow path continues after successful intake. The Commerce module has its own order normalizer; it does not change the legacy flow normalizer's message types or trigger semantics.

Commerce intake always verifies the original raw-body Meta signature, even when development settings allow the surrounding legacy webhook to bypass signature checks. After verification it uses the signed bytes as its source. Routing requires an exact, unambiguous active WABA and phone-number pair and an active, enabled workspace. It does not use the legacy phone-only/WABA-only fallback.

The complete received cart is encrypted in `CommerceEvent`. A workspace/event-key uniqueness constraint deduplicates receipt. Persistence failure returns a retryable webhook failure, before acknowledgement; a successfully persisted cart does not depend on an immediate Redis enqueue. Malformed identifiable carts enter a visible dead-letter state. Unmapped, ambiguous or disabled workspace traffic is not adopted by Commerce and continues through the existing inbox path.

The existing webhook worker sweeps at most 20 due cart events every 15 seconds. It claims expiring event ownership, validates the original catalog/WhatsApp binding, batch-loads products, and creates an order in `needs_review`. Order creation and event completion share a MongoDB transaction. Retry after a crash or duplicate receipt cannot intentionally create another order for the same workspace/WABA/message. Transient failures back off and stop after eight attempts; managers can inspect and retry dead-letter events.

## Order and review rules

- India/INR, 1-100 distinct products, whole quantities from 1 to 10,000. Documented string quantities and whole numeric quantities are normalized. Decimal source prices are parsed into exact integer paise; invalid/fractional-paise amounts fail validation.
- **Local product prices determine totals.** Source prices and quantities are immutable comparison snapshots. Price, quantity and removed-item differences are visible warnings.
- Unknown products and catalog mismatches do not create fabricated lines or totals. Known unavailable products, insufficient stock and unconfirmed tax remain visible as review blockers.
- Included tax uses the existing exact arithmetic. Unknown product/delivery tax remains null. Pickup requires a zero delivery charge and no delivery tax rate.
- Merchants may change quantities or remove/re-add products from the original cart, select pickup/delivery, record an Indian delivery address and set delivery charges. They cannot add unrelated products, supply authoritative unit prices or set payment/ownership fields.
- Address and customer note fields are encrypted at rest and excluded from default projections/document JSON. Authorized order-detail responses decrypt them; list responses omit those details. Audit logs include only order ID, workspace, revision and status.
- Review requires the last observed order revision, expected total, every current product revision and explicit warning acknowledgement. The backend recalculates the quote and rejects unseen price/product changes or blockers.
- Successful review records `reviewedAt`/`reviewedBy`; status stays `needs_review` until Stage 5 actually creates checkout. Any detail/quantity edit or customer fulfillment submission invalidates the review.
- Review is a point-in-time snapshot and does **not reserve stock**. Stage 5 must revalidate products/stock and conditionally reserve inventory before freezing a checkout attempt. A prior review never guarantees stock or authorizes a stale payment request.
- Stage 4 edit/cancel queries require an unpaid editable order with no active or paid attempt. Paid, awaiting-payment and fulfillment-stage orders cannot be changed through these APIs. Cancellation here is local and pre-checkout only.
- History retains its original workspace, catalog, WABA, phone and environment. A connection replacement cannot reassign old carts or orders.

## Fulfillment sessions

Managers can create a 30-minute fulfillment session for an editable order revision. The random token is returned once and stored only as a hash; its encrypted data binds the revision. The public API uses `Authorization: Bearer <token>`, never a workspace supplied by the customer.

A session read returns only the order number, expiry and available pickup/delivery options. It does not disclose existing addresses, customer phone, cart items or private notes. Submission can provide a supported fulfillment method and delivery address; it cannot alter prices, mark payment or approve merchant review. Session consumption and order update commit together. Expired, reused or superseded tokens fail independently of TTL cleanup; a failed order write rolls consumption back.

Possession of the token grants this limited capability. It is not customer identity verification. Keep tokens out of URLs, logs and analytics. A later frontend may carry a token in a URL fragment and submit it in the authorization header, but this stage creates no public form page or automatic WhatsApp send. Existing workspace permissions control session issuance.

## API contract

Paths below are relative to `/api/commerce`; the existing root `/commerce` alias applies. Management routes use authentication and `x-workspace-id`. Mutations require `application/json`. Reads/mutations reuse existing Commerce/ecommerce rate limits and permission overrides.

| Method/path | Permission / authorization | Input |
| --- | --- | --- |
| GET /orders/settings | commerce.orders.view | None |
| PATCH /orders/settings | commerce.orders.manage | Full settings and revision |
| GET /orders | commerce.orders.view | Required environment: test/live; optional status, cursor, limit 1-100 |
| GET /orders/:orderId | commerce.orders.view | Scoped order ID |
| GET /orders/:orderId/quote | commerce.orders.view | Fresh quote, warnings, blockers and product revisions |
| PATCH /orders/:orderId | commerce.orders.manage | Revision, fulfillment, delivery price/tax, optional cart quantities |
| POST /orders/:orderId/review | commerce.orders.manage | Revision, expected total, product revisions, acknowledgeWarnings: true |
| POST /orders/:orderId/cancel | commerce.orders.manage | Revision |
| GET /orders/events | commerce.orders.view | Status (default dead_letter), cursor, limit |
| POST /orders/events/:eventId/retry | commerce.orders.manage | Empty JSON object; dead-letter events only |
| POST /orders/:orderId/fulfillment-session | commerce.orders.manage | Revision; returns token and expiry |
| GET /fulfillment | Fulfillment bearer token | Limited public options |
| POST /fulfillment | Fulfillment bearer token | Pickup or delivery/address |

Settings example (revision 0 creates the first settings record; otherwise send the current revision):

```json
{
  "revision": 0,
  "enabled": true,
  "pickupEnabled": true,
  "deliveryEnabled": true,
  "pickupInstructions": "Collect at the counter.",
  "testRecipients": ["919999999999"]
}
```

Test recipients are explicit normalized phone numbers, limited to 20. Membership in this list fixes an incoming order's environment to `test`; other incoming orders are `live`. The environment is captured at intake and does not depend on the connected gateway. This settings API cannot enable live checkout or alter its payment flags.

Merchant delivery edit example:

```json
{
  "revision": 1,
  "fulfillmentMethod": "delivery",
  "address": {
    "name": "Test Customer",
    "phone": "919999999999",
    "line1": "Example address",
    "city": "Delhi",
    "state": "Delhi",
    "postalCode": "110001",
    "country": "IN"
  },
  "deliveryPrice": "20.50",
  "deliveryTaxRateBps": null,
  "items": [{ "sku": "TEA-REGULAR", "quantity": 2 }]
}
```

After editing, fetch `/orders/:orderId/quote`. Review submits its `totalPaise` as `expectedTotalPaise`, its `productRevisions`, the current order revision, and `acknowledgeWarnings: true`. A 409 requires a fresh quote/record; clients must not blindly replay stale approvals.

## Deployment preparation

The feature defaults off. No environment file, database, external account or deployment was changed.

1. Review `npm run commerce:indexes`: **12 collections and 37 indexes**. Three new query indexes support unfiltered environment order lists, bounded order-event discovery and workspace event lists. Order source snapshots/note/received-time fields are additive. No index application or data migration ran.
2. Apply/check reviewed indexes using the existing explicit staging database operator script. Readiness checks required indexes, the encryption key, and replica-set/sharded topology; it creates nothing.
3. Configure `COMMERCE_ORDERS_ENABLED=true` on API and existing webhook worker in isolated staging. Keep live checkout flags off. Existing `CREDENTIALS_ENCRYPTION_KEY` and Meta signing configuration must be valid.
4. Connect an actual active WhatsApp account, bind the intended catalog and create matching local products. Enable workspace Commerce through the settings API and configure explicit test recipients.
5. Verify the `commerce-orders-intake` scheduler, real signed cart receipt, preserved inbox visibility, duplicate/reordered delivery, worker restarts, MongoDB transaction rollback/failover and fulfillment API behavior on staging assets.
6. Confirm proxy/APM logs do not capture address bodies or authorization headers. The new HTTP boundary sanitizes parser/service failures but cannot configure external logging systems.

Events retain their intake catalog connection. Retrying an event does not migrate it to a new connection. A cart received before catalog binding or after a mismatched binding may require the customer to resend after setup is corrected.

## Verification

- **125/125 Commerce tests passed**, including **34 new Stage 4 tests** and all earlier regression tests.
- Command: `node --test --experimental-test-isolation=none src/modules/commerce/tests/*.test.cjs` on Node 22.14.
- Coverage includes raw signature enforcement, exact tenant routing, durable receipt failures, duplicate carts, malformed sibling messages, local-price authority, original binding/environment retention, rollback/restart simulation, merchant permissions, stale revisions, stock/tax blockers, encrypted addresses, single-use/expired/revoked-by-edit sessions and transaction query guards.
- **77 JavaScript/CommonJS files passed syntax checks.** Offline index planning, tracked diff whitespace checks and the existing backend build passed. The build script is a no-op; backend typecheck and executable lint are not configured.
- Repository adapters and transactions are simulated in tests. Real MongoDB concurrency/failover and query execution plans, Redis scheduler behavior, Meta delivery and production deployment have **not** been verified. HTTP tests exercise real authentication/permission middleware with mocked persistence/services; they do not exercise the complete legacy inbox stack against live infrastructure.
- Frontend was not changed or rebuilt. The user's existing `LandingNavbar.tsx` change is preserved.

**GO for Stage 5 implementation. NO-GO for production Commerce payment activation until checkout/payment stages and staging verification pass.**

## Files changed in Stage 4

- `src/infra/database/CommerceOrder.js`, `CommerceEvent.js`
- `src/modules/commerce/domain/orders.js`, `validators/orders.validators.js`, `repositories/orders.repository.js`
- `src/modules/commerce/services/orderIntake.service.js`, `orders.service.js`, `ordersReadiness.service.js`
- `src/modules/commerce/controllers/orders.controller.js`, `routes/orders.routes.js`, `routes/ordersHttp.js`
- `src/modules/commerce/tests/orders-domain.test.cjs`, `orders-intake.test.cjs`, `orders-service.test.cjs`, `orders-routes.test.cjs`, `orders-repository.test.cjs`, `orders-readiness.test.cjs`, `orders-fixture.cjs`
- `src/modules/webhooks/controllers/webhook.controller.js`, `src/core/routes/registerRoutes.js`, `src/infra/workers/webhook.worker.js`, `app.js`
- Stage 1 progress table and this report

## Official contracts reviewed

- [Meta Messages Object](https://www.postman.com/meta/whatsapp-business-platform/folder/1dtuocp/messages-object): order/catalog identifiers and product retailer ID, quantity, price and currency fields.
- [Meta WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api): current webhook payload examples and messaging envelope.
- [Meta's WhatsApp SDK webhook types](https://github.com/WhatsApp/WhatsApp-Nodejs-SDK/blob/main/src/types/webhooks.ts): string representations for incoming quantities/prices and order message metadata; consulted alongside the API collection, not installed as a dependency.

The local quote/review policy is the agreed AIWizChat architecture; receipt of a WhatsApp order is not payment evidence.
