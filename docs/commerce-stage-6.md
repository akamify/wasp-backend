# Merchant-owned Commerce: Stage 6

Updated: 2026-09-10. Stage 6 implementation is complete locally. Browser acceptance, real database/queue integration and merchant-provider validation remain release gates. Nothing has been deployed or enabled in production.

## Result

**PASS for local implementation and automated verification. GO for Stage 7 implementation. NO-GO for production activation until the release gates below pass.**

Stage 5 supplied checkout and payment recovery APIs but had no Commerce dashboard, customer fulfillment page or inbox commerce actions. It also checked an undefined `messages.send` permission in the confirmation worker. Stage 6 supplies the UI and operations, and corrects that check to `commerce.messages.send`.

## Implemented behavior

- Lazy-loaded `/app/commerce/products`, `/orders`, `/orders/:id`, `/payments` and `/settings`, with existing app shell, components and workspace authorization. Navigation is available in the shared desktop/mobile menu.
- Products: cursor pagination, create/edit, inclusive INR price and explicit tax confirmation, reserved-stock visibility, availability, stock adjustment, archive confirmation, sync state/retry, HTTPS image URL and JPEG/PNG upload through the existing media API.
- Orders: environment/status filtering, details, customer cart notes/address, quantity corrections within the original cart, pickup/delivery charges, fresh server quote and acknowledged review. Checkout accepts the reviewed revision, merchant connection ID and a stable request key; the browser never supplies an authoritative payable total. Payment attempts can be refreshed, reconciled and cancelled through the existing guarded APIs.
- Public `/commerce/fulfillment#<token>` page: a short-lived bearer session, sent only in the authorization header. The fragment is removed after load and no session token/address is saved in browser storage. The page uses a separate public HTTP call so the SaaS token/workspace interceptors cannot replace the fulfillment token. The server's one-use/revision/expiry rules remain authoritative.
- Payments: explicit test/live views, verified captures and refunds, extra-payment attention, order links, event processing retries and confirmation status. Refund execution remains in the merchant's Razorpay dashboard. Captured payment is not presented as bank settlement.
- Settings: current catalog/phone state, dedicated catalog binding, visibility/cart settings, order intake, pickup/delivery configuration, test recipients, checkout/reservation gates, manual keys, OAuth, merchant identity and webhook setup. Order and checkout forms refresh together because they share a server revision; checkout setup explains when order initialization is still required. Gateway ID/credentials status, identity and webhook state are separate. Native payment capability remains false. Secrets stay transient in the form/one-time setup dialog.
- OAuth browser callbacks return to the configured frontend origin when the browser accepts HTML; JSON API callers retain their existing response. Only a fixed Commerce settings path and non-sensitive status are returned. Configure `FRONTEND_BASE_URL` or `APP_BASE_URL`; without a valid configured origin the callback retains JSON behavior. An OAuth callback does not change the currently selected workspace.
- Inbox: product picker (maximum 30), server-selected catalog thumbnail, complete catalog message and existing-customer payment request. All sends require Commerce permission, inbox reply permission and an open customer service window. Product selection requires available, synchronized products. Payment requests must belong to the customer, current catalog/WABA/phone and active unexpired attempt. Payment details are fetched on explicit inspection rather than once for every order row.
- Inbox rendering: inbound cart quantities/SKUs are labeled as customer cart data; current prices and payment status come from order review. Outbound catalog/product and payment-request cards retain the shared sender's delivery state and link to the authoritative order.
- Fulfillment: verified paid orders advance `confirmed → processing → ready → completed` for pickup, or `confirmed → processing → out_for_delivery → completed` for delivery. Stale revisions, unresolved attempts, refunds and extra payments block advancement. Late capture after stock release requires explicit merchant acknowledgment and an atomic available-stock allocation before confirmation. Refunds never automatically restock inventory.
- Only confirmations blocked before dispatch can be retried. Retry reauthorizes the current operator, preserves the original customer/order/channel and uses the existing durable outbox. Unknown dispatches require inbox inspection; they are not blindly resent.

## Workspace and concurrency controls

The Commerce request scope pins `x-workspace-id`, bypasses shared GET caching/coalescing, aborts pending requests when disposed and discards stale responses. A request interceptor also verifies the pinned workspace before dispatch and after auth refresh. Credential refresh preserves the selected workspace, preventing an old JWT workspace from undoing a user's selection while a checkout is in flight. Ordinary login token behavior and ordinary GET coalescing are preserved.

The shared outbound sender reserves/claims the existing Message record before provider dispatch. Commerce request hashes prevent reuse of a key for different destinations/product IDs/attempts. Existing sent/uncertain messages are returned without another provider POST. Product and catalog messages reuse quota checks, channel binding, inbox persistence and realtime delivery. The Graph adapter pins the stored version/phone endpoint, disables redirects, bounds time/body size and sanitizes provider failures.

One additive order lookup index was declared: `{workspaceId:1, environment:1, customerPhone:1, _id:-1}`. The offline plan now contains **12 collections and 43 declared indexes**. No database fields or data migration were added in this stage; the index has not been applied. Payment readiness checks require it, so apply/check the reviewed index plan before enabling the new release. No live query execution plan was inspected because no dedicated database was connected.

## API additions

Both existing `/commerce` and `/api/commerce` aliases are registered. Existing Stage 2–5 endpoint contracts remain in use rather than adding duplicate settings/gateway aliases from the initial planning sketch.

| Endpoint | Authorization / behavior |
| --- | --- |
| `GET /access` | Active workspace membership; permissions and deployment feature flags, not a claim of provider readiness |
| `GET /orders/inbox?environment=test&to=...` | Orders view; exact current WABA/phone/customer; cursor pagination |
| `POST /orders/:id/fulfillment` | Orders manage; revision and allowed target status; transactions and verified payment |
| `POST /notifications/:id/retry` | Commerce send; blocked-before-dispatch only; current operator authorization |
| `POST /messages` | Commerce send + inbox reply; strict kind/recipient/key/product IDs or attempt ID; server-built Meta payload |

Private responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Mutations are validated, rate-limited and audited without credentials or customer address contents.

## Files changed in Stage 6

Backend:

- New `domain/fulfillment.js`, `domain/oauthReturn.js`, `validators/operations.validators.js`, `repositories/operations.repository.js`, `routes/operations.routes.js`.
- New `services/operations.service.js`, `services/commerceMessages.service.js`, `services/metaCommerceMessages.service.js`.
- Updated `domain/orders.js`, `services/paymentOutbox.service.js`, `controllers/gateway.controller.js`, `routes/paymentsHttp.js`.
- Updated `src/core/routes/registerRoutes.js`, `src/shared/services/outboundMessageService.js`, `src/infra/database/CommerceOrder.js`.
- Added operations/message/repository/HTTP tests and extended OAuth route coverage. Updated this report and the stage tracking table.

Frontend:

- New `src/modules/commerce/`: dashboard and four screens, inbox actions, public fulfillment and address components, UI helpers, typed contracts, request scope and query/action context.
- Updated `src/api/api.js`, public/user routes and app-shell navigation.
- Updated conversation workspace, message content and message payload types.
- Added `tests/commerce-scope.test.mjs`, `tests/commerce-api.test.mjs`, `tests/commerce-render.test.mjs`.

Earlier Stage 1–5 work and the existing unrelated `LandingNavbar.tsx` edit were preserved. No package dependency, environment change, commit or deployment was introduced.

## Verification

- **186 backend tests passed**, including all previous 167 Commerce tests. Coverage includes real authentication/membership/permission middleware with isolated persistence; strict HTTP payloads; product/catalog message contracts; cross-tenant/customer/channel rejection; duplicate/unknown dispatch; fulfillment state, stock shortage, rollback and concurrent revision conflicts; blocked-notification retry; actual confirmation permission and OAuth HTML/JSON callback behavior.
- **17 frontend tests passed**: request scope isolation/cancellation, actual Axios interceptors and refresh retry across workspace changes, ordinary GET behavior, and server-rendered real TSX for permission-gated products/orders/settings, initial setup, loading/empty/error states, money/stock display, escaping and inbox Commerce content. These render tests use deterministic API hook results; they are not interactive browser tests.
- JavaScript/CommonJS syntax checked on **105 files**. Offline index plan checked: 12 collections, 43 indexes; no database connection.
- Frontend TypeScript and production Vite build passed. A sandboxed retry hit Windows `spawn EPERM`; the build was subsequently rerun with approved local execution. Build emits outdated-gradient and large existing application-chunk warnings. Commerce is emitted as lazy chunks; no unrelated CSS/bundle refactor was made.
- `git diff --check` passed in both repositories. The repositories do not configure a standalone lint command. Backend is CommonJS with no typecheck and its build script is a no-op; syntax/tests are the applicable backend checks.

Reproduce from the respective repository roots:

```powershell
# Backend (test isolation disabled only for sandbox child-process restrictions)
node --test --experimental-test-isolation=none src/modules/commerce/tests/*.test.cjs
node scripts/commerce-indexes.cjs --plan

# Frontend
node --experimental-vm-modules --test --experimental-test-isolation=none tests/commerce-*.test.mjs
npm run build
```

## Remaining release gates

1. Interactive browser/mobile acceptance was attempted but the browser tool failed during initialization with `codex/sandbox-state-meta: missing field sandboxPolicy`. No authenticated browser checkout/form interaction or screenshot verification is claimed.
2. Run against a dedicated MongoDB replica set and Redis: apply/check reviewed indexes, last-stock concurrency, transaction rollback, queue restart, recovery and notification retry. Current transaction tests use isolated repositories; actual MongoDB/Redis durability is not established by them.
3. Complete an authorized merchant test-mode journey using a real dedicated catalog, open WhatsApp customer window, manual gateway and OAuth setup, signed webhook, paid order, fulfillment and dashboard refund. Verify deployment HTTPS cookies, callback origins and client route fallback. No real provider mutation/message/payment occurred here.
4. Perform existing application smoke checks (ordinary inbox, campaigns, wallet/subscriptions and connectors) in staging. No executable general campaign regression suite exists beyond its placeholder; shared sender idempotency and shared API behavior were checked locally.
5. Keep native WhatsApp payments unverified and production checkout disabled until account-specific eligibility and Stage 7 integration/release work pass. Ordinary hosted Payment Links do not establish native payment eligibility.

## Official contracts reviewed

The product and catalog payloads follow Meta's official examples: [single-product messages](https://www.postman.com/meta/whatsapp-business-platform/request/syvmul4/send-single-product-message), [multi-product messages](https://www.postman.com/meta/whatsapp-business-platform/request/j1w5o6p/send-multi-product-message) and [catalog-message payload](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-e1446141-746e-4fc8-9b6c-dd590ed4f924). The catalog message supplies a real synchronized retailer SKU as its thumbnail. Example API versions are not copied into runtime code; the stored connection version is used.

Gateway authentication, payment links, signature verification and native eligibility references remain in the Stage 3–5 reports. Reading documentation does not verify a merchant's live provider setup.
