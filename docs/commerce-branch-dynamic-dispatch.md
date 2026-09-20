# Nearest branch and dynamic courier batches

This update supersedes the 10-order limit and fixed-zone-only description in commerce-delivery-batching.md. Existing fixed-zone trips remain supported.

## Merchant flow

1. Configure branch locations, opening hours, service radii and per-product stock.
2. In Dispatch Settings, enable automatic nearest-branch selection if desired. This is independent of courier Auto Dispatch. Both default OFF. Routing/delivery flags and the routing worker must be available.
3. After customer delivery location is confirmed through the existing order-details flow, new unaccepted delivery orders become eligible for branch selection. The worker geographically shortlists open/serviceable branches with enough stock for every item, then compares Google driving road distance for the configured shortlist. Branch selection is bounded to 100 active branches and at most routeShortlist road origins. It is nearest within this shortlist, not an exhaustive road comparison of every branch.
4. The worker stores a recommendation, increments order revision and writes a durable merchant notice. Restaurants & Branches → Orders and couriers shows that branch's acceptance queue and nearby pickup candidates/remaining slots. The queue and notices use existing merchant workspace permissions; this update does not introduce isolated branch-staff accounts or external WhatsApp/email notifications.
5. Open the order to accept. The recommended branch is preselected; nearest selection and inventory are rechecked on acceptance. Manual branch selection remains available. A changed recommendation requires refresh. A branch suggestion does not reserve inventory; the existing checkout reservation remains authoritative.
6. Existing quote approval, verified payment and preparation precede rider offers. Courier Auto Dispatch OFF leaves assignment to the merchant. Single and bulk manual assignment remain available. Accepted/preparing orders are never automatically moved to another outlet.

Branch selection polls every 10 seconds, claims at most five orders per run, uses a one-minute recovery lease and transitions to manual selection after three provider failures. Empty eligible results prompt manual selection immediately. Revision/token checks prevent an old worker overwriting manual acceptance or edited orders. There is no automatic order cancellation.

## Courier controls

Add/Edit Courier now includes address, capacity 1–30, batch area mode, first-customer radius (100–50,000 m), pickup radius (100–50,000 m) and courier auto assignment. Existing separate-login onboarding is retained; riders register their own account before linking. Existing couriers default to fixed_zone; the new creation form defaults to first_customer, capacity 1 and auto OFF.

First-customer mode requires no fixed zone. On the first assignment, the customer's coordinates and courier radius are snapshotted on the trip. Every subsequent order must be within that unchanged centre/radius, from the same merchant/outlet/environment, with matching pickup coordinates and compatible ready times. Removing the first order does not move the centre. Lowering courier radius additionally constrains new additions; increasing it does not expand an existing trip. Fixed-zone OFF switches apply to fixed-zone couriers; first-customer couriers are governed by courier/global switches instead.

Dynamic trip safety bounds currently are 300 seconds ready-time tolerance, 300 seconds pickup wait, 7,200 seconds total route including stops, 1,800 seconds detour and 120 seconds per stop. These are backend defaults, not new panel controls. Capacity is a maximum, not a departure target. Thirty orders are permitted only if route/timing limits also pass. First pickup locks additions. Offers consume capacity, require rider acceptance and release their own slot on decline/expiry/reassignment/completion. Trip mode cannot change during an active trip.

The effective pickup radius is the smaller of the merchant-wide and courier-specific setting. Recent accurate GPS, online/active status, allowed outlet, vehicle and remaining capacity are required. Nearest pickup priority ranks the bounded shortlist by road ETA. Existing batch priority prefers loading trips within that shortlist, then uses the selected SMART/nearest strategy. Neither mode guarantees a named courier is always filled first.

Bulk assignment supports up to 30 selected orders. Choose the First customer radius option for dynamic couriers, or an allowed fixed zone for fixed-zone couriers. Selection order defines the first customer and stop sequence; road feasibility is checked before reserving. This is not a route optimizer.

Route checking fetches only direct and predecessor legs: at most 15 requests and 90 matrix elements per 30-order trip check, two calls concurrently. Preview and confirm each check routes. Automatic candidate ranking and retries add provider calls. Monitor quotas and billing.

## Deployment

- Keep automatic features OFF while deploying the same code version to all API/worker processes. Do not mix old single-order/trip-unaware workers with this version.
- Prepare and check BOTH index plans: `node scripts/commerce-indexes.cjs --plan` and `node scripts/commerce-delivery-indexes.cjs --plan`, followed by explicit `--apply` / `--check` for each on the intended replica-set database. The CommerceOrder plan adds branch-routing recovery and branch-queue indexes. No existing index is dropped.
- Index scripts use explicitly supplied COMMERCE_MONGODB_URI and COMMERCE_MONGODB_DB. Application runtime still uses MONGODB_URI. Preserve CREDENTIALS_ENCRYPTION_KEY.
- Existing Google keys suffice: frontend VITE_GOOGLE_MAPS_API_KEY and backend/worker COMMERCE_GOOGLE_ROUTES_API_KEY. No new provider account or environment secret is required.
- Existing flags COMMERCE_DELIVERY_ENABLED, COMMERCE_MANUAL_DISPATCH_ENABLED, COMMERCE_ROUTING_ENABLED, COMMERCE_BATCHING_ENABLED and (for automatic courier offers) COMMERCE_AUTO_DISPATCH_ENABLED remain applicable.
- Redeploy frontend, restart API/workers, enable merchant branch selection and configure couriers. Orders already present before this update are not silently migrated; use their nearest-branch button or reconfirm editable details to queue them.
- Pilot with two branches and capacity 2 before raising capacity. Verify real road responses, GPS, payment/stock, two concurrent acceptance sessions, worker restart, provider outage, manual takeover, pickup locking and PIN completion.

## Verification

281 backend Commerce tests and 39 frontend Commerce tests passed locally. TypeScript and Vite production build passed; bundle-size warnings remain. Syntax and offline index-plan checks passed. Tests use controlled database/provider mocks and do not prove live MongoDB isolation, Google Maps rendering or real rider-device operation. No live deployment, environment editing or index application was performed. Neither package provides a lint script.

Primary backend changes: delivery/branches.js, batching.js, models.js, validators.js, domain.js, routes.js, service.js, routingSettings.js; CommerceOrder.js; order details/DTO integration; webhook worker scheduling; delivery tests. Frontend changes: BranchDispatch.tsx, DeliveryManagement.tsx, BatchingManagement.tsx, RoutingAssistance.tsx and render tests.
