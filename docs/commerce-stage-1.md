# Merchant-owned Commerce: Stage 1

Updated: 2026-09-10. Stage 1 is the backend foundation increment, not a working checkout release.

Stage 2 subsequently adds catalog/product APIs and background sync. See [Stage 2 implementation and verification](commerce-stage-2.md). Counts and verification below describe the original Stage 1 increment.

## Confirmed scope

Both Manual API Keys and OAuth are supported by the gateway data model. Manual onboarding comes first; OAuth activation depends on the merchant/partner integration. Native WhatsApp payment configuration is a separate capability and begins unverified.

Customer-sale payments must use the workspace's own merchant connection. Platform billing and wallet credentials must never be fallback credentials for Commerce.

## Implemented

- Twelve additive Mongoose models: settings, catalog connection, product, gateway connection, order, checkout attempt, inventory reservation, payment, refund, event, outbox and expiring session.
- Workspace ownership is required and immutable; historical catalog/gateway references are immutable. Gateway and checkout environments distinguish test and live.
- Ten Commerce permissions integrated into the existing workspace authorization service. Owner/admin get all by default; managers manage catalog/orders; agents can view catalog/orders and send messages; viewers have read access. Existing permission overrides continue to apply.
- An explicit workspace query constraint that cannot be overridden by another filter. It must receive an ID from verified access, not directly from request parameters.
- Integer-paise quotes, bounded quantities/amounts, duplicate SKU rejection, inclusive-tax arithmetic using BigInt and half-up rounding per line. Unknown tax, including tax on a delivery charge, remains unknown.
- Order transition validation, unknown checkout outcome state, and a pure captured-payment correlation check. These helpers do not execute transactions or confirm orders themselves.
- Credential encryption reusing the existing AES-256-GCM utility. Encrypted envelopes bind values to workspace, record and field. Hidden fields are excluded from normal projections and document JSON, including explicitly selected documents.
- Twenty-nine declared indexes covering active connection/attempt uniqueness, deduplication, reconciliation and bounded query access patterns.
- Safe index tooling: offline plan by default; explicit check/apply modes; no startup migration, data deletion or index dropping.
- Focused Node tests without new dependencies.

## Files

| Area | Files |
| --- | --- |
| Models | `src/infra/database/Commerce*.js` |
| Domain rules | `src/modules/commerce/domain/money.js`, `states.js` |
| Model helpers | `src/modules/commerce/models/schema.js`, `index.js`, `indexPlan.js` |
| Tenant query scope | `src/modules/commerce/repositories/scope.js` |
| Encryption | `src/modules/commerce/services/commerceSecrets.service.js` |
| Permissions | `src/modules/commerce/constants/permissions.js`, `src/modules/workspaces/constants/workspacePermissions.js` |
| Verification | `src/modules/commerce/tests/*.test.cjs`, `scripts/commerce-indexes.cjs`, `package.json` |

No Commerce HTTP routes, workers, frontend screens or gateway API calls are introduced in this increment. The only existing runtime integration is the additive permission list. Commerce settings and live checkout default to disabled. Platform wallet, billing, Meta webhooks and ecommerce connectors are unchanged.

## Verification commands

```sh
npm run test:commerce
npm run commerce:indexes
npm run build
```

The backend build script is an existing no-op. Backend TypeScript checking and executable ESLint tooling are not configured; syntax checks and the focused tests are the applicable local gates.

Local results: 28 tests passed using `npm run test:commerce`; all added/modified JavaScript files passed `node --check`; the offline index plan and backend build script passed. The first sandboxed test attempt hit Windows `spawn EPERM`; the standard command passed when allowed to start Node test processes. No database-backed concurrency, provider sandbox or production test is included in these results.

The default index command prints 12 collection definitions and 29 indexes without loading an environment file or connecting to MongoDB.

For a later explicitly selected staging database, set `COMMERCE_MONGODB_URI` and `COMMERCE_MONGODB_DB` in the operator environment, then use:

```sh
npm run commerce:indexes -- --check
npm run commerce:indexes -- --apply
```

`--check` is read-only and fails if required indexes are missing or incompatible. Both connected modes require replica-set or sharded topology. `--apply` creates indexes, stops on conflicts or duplicate data, and does not delete duplicates or drop conflicting indexes. Earlier indexes can remain created if a later index fails. Session TTL is the only automatic expiry; payment/order/reservation history has no TTL.

These connected commands have not been run. No database has been migrated or deployment performed. No local MongoDB server, shell or Docker executable was available for isolated database integration tests.

## Required contracts for subsequent stages

1. Routes must enforce authentication, active workspace membership and the relevant Commerce permission through existing middleware/services before repository calls. The query helper is not an authorization substitute.
2. Catalog sends must additionally validate the active WABA and phone binding. Connection replacement cannot move historical records.
3. The gateway service must verify credentials before persisting a connected record. Manual credential verification alone does not prove account identity, KYC, or native-payment eligibility. A fingerprint only catches reuse of the same key; verified account identity is needed to enforce the same-account restriction across different keys.
4. Services must call the encryption helper before persistence and use allowlisted DTOs for responses. Mongoose `lean()` results and raw driver operations bypass document JSON transforms. Never log OAuth callback query strings, tokens, webhook signatures, encrypted payloads or addresses.
5. Mongoose references are not foreign keys. Services must load referenced records within the same workspace and environment. Cross-document ownership, quote consistency, stock invariants and state transitions require transactional service checks.
6. Declared unique indexes protect concurrency only after they have been applied. Inventory reservation/consumption and payment confirmation must use MongoDB transactions plus conditional revisions/statuses. Live integration and concurrency tests are still required.
7. OAuth/fulfillment session consumption must atomically require `usedAt: null` and `expiresAt > now`; TTL cleanup alone is not validity enforcement.
8. Captured-payment correlation must receive resources fetched using the checkout's stored merchant connection. A browser redirect, unsigned event or payload notes cannot establish payment or workspace ownership.
9. Webhook handlers must authenticate raw bytes before parsing, persist verified events before acknowledgement, and tolerate duplicates and out-of-order delivery.
10. Native payments stay gated until the actual WABA, payment configuration and current provider payload contracts are verified. Captured payment is distinct from bank settlement.

## Remaining stages

| Stage | Deliverable | Status |
| --- | --- | --- |
| 1 | Data, permissions, domain/security primitives, index tooling, tests | Implemented locally |
| 2 | Products, catalog binding and Meta sync | Implemented locally; see Stage 2 report |
| 3 | Manual gateway onboarding and gated OAuth connection | Implemented locally; see Stage 3 report |
| 4 | Cart intake, order review and fulfillment details | Implemented locally; see Stage 4 report |
| 5 | Payment Links, raw signed webhooks, transactions and reconciliation | Implemented locally; see [Stage 5 report](commerce-stage-5.md) |
| 6 | Catalog/inbox UI and fulfillment operations | Implemented locally; see [Stage 6 report](commerce-stage-6.md); browser/provider acceptance pending |
| 7 | Account-verified native WhatsApp payments and production rollout | Implemented locally; see [Stage 7 report](commerce-stage-7.md); real-account, infrastructure and browser acceptance pending |

Current status: GO for controlled staging acceptance. NO-GO for enabling production Commerce payments until the Stage 7 release gates pass.

## Official reference contracts

- [Razorpay authentication](https://razorpay.com/docs/api/authentication/): merchant credentials and test/live modes.
- [Razorpay OAuth integration](https://razorpay.com/docs/partners/technology-partners/onboard-businesses/integrate-oauth/integration-steps/): authorized merchant access and token lifecycle.
- [Razorpay Payment Link lookup](https://razorpay.com/docs/api/payments/payment-links/fetch-id-standard/): link reference, linked order and captured payment IDs used by the correlation helper.
- [Razorpay webhook validation](https://razorpay.com/docs/webhooks/validate-test/): raw-body signature verification, event deduplication and out-of-order delivery.
- [Razorpay WhatsApp integration](https://razorpay.com/docs/payments/whatsapp/integrate/): separate WhatsApp account linkage.
- [Meta's official product-message collection](https://www.postman.com/meta/whatsapp-business-platform/request/syvmul4/send-single-product-message): catalog ID and retailer SKU contract for the next stage.

Documentation review does not establish that a particular merchant, WABA or live Graph API configuration is enabled.
