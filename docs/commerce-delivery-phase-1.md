# Commerce delivery: Phase 1

Scope: merchant-controlled manual delivery only. No smart dispatch, cross-merchant
fulfillment, shared payment gateway, automatic reassignment or multi-order riders.
Existing catalog, gateway, checkout and payment reconciliation remain authoritative.

## Implemented workflow

1. Open **Ecommerce Management** at the existing `/app/commerce` URLs. Delivery
   tabs appear only when the delivery flag and workspace permission are present.
   Overview and Reports & Activity show persistent paginated delivery notices.
2. Create a branch with pickup address, coordinates, opening hours, service radius
   and preparation time. Hours currently use Asia/Kolkata and same-day intervals;
   unselected days are closed. This version does not provide overnight or split shifts.
3. Enable tracked inventory for delivery products. Use **Initialize branch
   inventory** to explicitly move a product's existing on-hand and reserved stock
   to ONE initial outlet. Other outlets receive stock only through explicit edits.
   Existing reservations without an outlet remain bound to that initial outlet.
   After migration, edit stock through branches, not the generic product form.
   Prices and product content remain merchant-wide; Meta shows aggregate stock.
4. Receive a WhatsApp cart. Its durable event wakes the existing BullMQ intake;
   the order and `new_order` notice commit together. The existing scanner recovers
   from a failed queue wake-up. Notifications and dispatch screens refresh from API.
5. Customer supplies address, GPS or a map selection, then explicitly confirms the
   delivery location. The server records the confirmation timestamp. GPS alone
   does not confirm the destination. Merchant can edit before checkout lock.
6. Merchant selects an open, active, serviceable branch and preparation estimate,
   accepts the restaurant order, approves the current quote and creates payment.
   Branch/quote/address changes invalidate acceptance. All products must have
   sufficient available stock at the accepted outlet. Unpaid rejection closes the
   delivery record too; changing to pickup detaches it transactionally.
7. Only verified captured payment without refund/overpayment issues permits
   preparation and dispatch. Start preparation, then mark food ready. Payment,
   preparation and delivery statuses remain separate. No automatic refund is
   initiated by a delivery cancellation or exception.
8. Add a courier using an existing active registered AIWizChat email. Use a
   separate rider login without membership in the merchant workspace. The courier
   profile grants only self-scoped rider APIs; it grants no workspace membership,
   catalog, payment or admin permission. Profile is limited to one merchant.
   Do not also invite that account as a merchant team member.
9. Rider opens `/rider`, logs in, goes online and permits GPS. Foreground GPS
   uploads default to 15 seconds, configurable to 10–60 seconds. It is not a
   continuous background tracking service. Current assignment and offers recover
   from API after reconnect. Customer details are withheld until acceptance.
10. In Live Dispatch, inspect payment/preparation, branch, destination, rider
    workload, GPS age/accuracy and approximate straight-line distance to pickup.
    Select a rider and create a 20-second offer. An eligible rider must be active,
    online, free, allowed at that outlet, with GPS at most 60 seconds old and
    accuracy at most 100 metres. The server verifies eligibility; UI distances
    are not routing decisions or road ETAs.
11. Rider accepts or declines. Expiry/decline releases the rider for another manual
    offer. Unique indexes and transaction/revision checks enforce one active
    delivery per rider and one delivery record per order. Pre-pickup reassignment
    needs a reason. After pickup, use the issue/exception workflow.
12. Merchant creates a private customer PIN/tracking link and shares it with that
    customer through the existing chat. This action does not send a message itself.
    A new link rotates both token and PIN. Link lifetime is 24 hours. Token is
    hashed, PIN is encrypted and HMAC-protected, and neither is in rider DTOs.
    Rider confirms pickup, starts delivery and submits the customer's PIN only
    after handover. Five failed attempts lock verification for 15 minutes.
    Completion invalidates PIN/link and releases the rider. An override requires
    `commerce.delivery.override`, a recorded reason and valid order/payment state.

## Feature flags and hosting

- Existing Commerce, catalog, orders, gateway and payment flags/configuration must
  already be correctly configured. Merchants retain their own gateway accounts.
- `COMMERCE_DELIVERY_ENABLED=true` enables delivery APIs, UI capability, order
  location/acceptance gates, sockets and recovery scheduling.
- `COMMERCE_MANUAL_DISPATCH_ENABLED=true` enables new restaurant acceptances and
  offers. Set this to false to pause new dispatch while resolving existing work.
- `COMMERCE_RIDER_GPS_SECONDS=15` optionally configures foreground GPS uploads.
- `CREDENTIALS_ENCRYPTION_KEY` must remain the existing valid 32-byte base64 key.
  Do not rotate it without the platform's credential migration procedure.
- Build the frontend with `VITE_GOOGLE_MAPS_API_KEY`; enable Maps JavaScript API
  and restrict the key to the intended frontend origins and API. Map load failures
  are visible; GPS selection remains available with customer confirmation.
- HTTPS, secure authentication cookies, SPA fallback for `/rider`, `/login` and
  `/delivery-tracking`, and serving the rider manifest/icons/service worker are
  required. The PWA caches only a generic offline page, not private API data.
- Run the existing webhook worker and Redis/BullMQ. Delivery expiry recovery is
  scheduled every five seconds and scans bounded batches. Do not rely on a web
  process alone. Keep payment and catalog recovery workers operational.
- Proxy `/socket.io/` to the backend including WebSocket upgrades and its bundled
  client script. `/delivery` uses authenticated server-derived scopes and only
  emits invalidation events. State always comes from authorized API reads.
  HTTP polling remains available if sockets fail. No Web Push is included here.
- Read/action rate budgets are per verified account, so riders sharing restaurant
  Wi-Fi do not exhaust one shared delivery budget. PIN attempt limits are persisted
  in MongoDB and remain effective across backend processes.

The Dispatch Settings screen shows the fixed manual-mode operating limits above;
it does not expose a configurable auto-dispatch engine.

## Explicit database preparation

New models use `autoCreate=false`, `autoIndex=false`, strict schemas and scoped
queries. MongoDB must support transactions (replica set or sharded cluster).
Delivery readiness fails closed if topology, encryption or indexes are missing.

From `wasp-backend`:

```powershell
node scripts/commerce-delivery-indexes.cjs --plan
# In the deployment environment, explicitly set COMMERCE_MONGODB_URI and
# COMMERCE_MONGODB_DB to the intended database, then:
node scripts/commerce-delivery-indexes.cjs --check
node scripts/commerce-delivery-indexes.cjs --apply
node scripts/commerce-delivery-indexes.cjs --check
```

Apply existing Commerce indexes separately using its existing runbook. The delivery
script creates indexes only; it never drops indexes, deduplicates orders or copies
stock. Investigate conflicting indexes/duplicates rather than deleting records.
Deploy API/worker/frontend with delivery flags off, prepare indexes, then enable
delivery in a staging environment first. Once orders use branch inventory, rollback
must preserve its reservation accounting; do not roll back to code unaware of it.
Pause new dispatch with the manual flag, and drain existing deliveries before
turning off all delivery endpoints.

## Verification and release gate

Local results on 2026-09-17: 228 backend Commerce tests passed; 28 frontend
Commerce tests passed; 86 backend JavaScript syntax checks passed; delivery index
plan, manifest/PNG dimensions and whitespace checks passed. Frontend `npm run
build` (TypeScript + Vite) passed. The final build required permission to spawn
Vite's Windows helper after a sandbox `spawn EPERM`. Build still reports CSS
gradient syntax and large-chunk warnings. Neither repository has a configured
lint command; backend build is a no-op rather than a compilation check.

Local commands:

```powershell
# Backend
node --test --experimental-test-isolation=none --test-reporter=spec src/modules/commerce/tests/*.test.cjs
node scripts/commerce-delivery-indexes.cjs --plan
# Frontend, from wasp-frontend
node --experimental-vm-modules --test --experimental-test-isolation=none tests/commerce-*.test.mjs
npm run build
```

Tests cover tenant permissions, feature gates, location validation, stock movement,
reservation ownership, schema-valid sync writes, offer replay/expiry, competing
acceptance, PIN failures/completion/override, native status authorization, legacy
fulfillment bypass prevention and frontend rendering/navigation. Service concurrency
tests use controlled mocks; they are not real replica-set concurrency/load tests.

Before enabling live delivery, verify on staging:

- Real MongoDB competing accepts/reservations, transaction rollback and duplicate
  webhook delivery; run index `--check` against the actual database.
- Real merchant test gateway capture, late capture, refunds and Meta catalog sync.
- Two merchant sessions cannot access each other's branch, rider, stock or orders.
  Rider session cannot call merchant catalog/payment/admin APIs.
- Worker restart/Redis outage, offer expiry, socket reconnect and API recovery.
- Customer GPS denial/map selection/confirmation on actual mobile devices; browser
  key restrictions and HTTPS. Install `/rider`, log in, accept/decline, navigate,
  submit correct/incorrect PIN, background/foreground recovery and offline page.
- Merchant override/returned-delivery exception and pre-pickup reassignment with
  audit reasons. Completion must not be possible through the legacy order action.

No deployment, live order, DB index application or device acceptance was performed
as part of local implementation. Those remain the live-release gate.

## Files and official references

Backend: `src/modules/commerce/delivery/`, related order/payment/inventory services
and repositories, optional fields on CommerceOrder/Product/InventoryReservation,
workspace permissions, route registration, websocket/worker hooks, rate limiters,
the explicit index script and focused Commerce tests.

Frontend: `src/modules/commerce/DeliveryManagement.tsx`, `RiderPage.tsx`,
`LocationPicker.tsx`, `DeliveryTrackingPage.tsx`, `deliverySocket.ts`, existing
Commerce routing/address/order/context/types, sidebar label, login return routing,
`public/rider*` and Commerce tests.

- [Google Maps events](https://developers.google.com/maps/documentation/javascript/events)
- [Google Maps circle overlay](https://developers.google.com/maps/documentation/javascript/shapes#circles)
- [Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)
- [PWA installability and manifest icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [Socket.IO authentication middleware](https://socket.io/docs/v4/middlewares/)
