# Same-outlet delivery batching

Updated behavior (capacity up to 30, dynamic first-customer batches and branch selection) is documented in [commerce-branch-dynamic-dispatch.md](commerce-branch-dynamic-dispatch.md). Its limits and rollout instructions supersede the original limits below.

## Scope and controls

Ecommerce Management now has Delivery Zones and Batch Dispatch tabs. A trip belongs to one merchant, outlet, environment and courier. Pickup coordinates must match. Customers must fall inside the selected destination circle. Pending offers consume capacity immediately; courier acceptance remains required.

- Courier capacity: configurable 1–10 orders, default 1. Reducing capacity does not discard existing orders; further additions stop until there is room.
- Zones: editable map circle and numeric coordinates/radius (100–50,000 metres), default 4 km. Address search uses Google Geocoding. Numeric inputs remain available when the map cannot load.
- Each zone has active/auto switches, priority, preparation tolerance, maximum pickup wait, trip duration, detour and stop allowance. Defaults: 300 s preparation tolerance, 300 s pickup wait, 3,600 s trip duration, 600 s detour, 120 s per customer stop.
- Each courier has an auto switch and allowed zones, in addition to existing outlet permissions and eligibility checks. Global auto dispatch, zone auto assignment and courier auto assignment must all be ON.
- Overlapping active zones: lowest priority number, then ID, wins. An OFF auto switch on the matching zone causes manual fallback; it does not fall through to another zone. Automatic lookup supports at most 100 active zones per outlet.
- Existing configurable pickup radius, GPS freshness, uncertainty, road shortlist and offer lifetime remain authoritative. Customer-zone radius is separate from rider-to-outlet pickup radius.

Automatic dispatch geographically shortlists eligible riders before Google road ranking, prefers compatible loading trips, and appends orders without changing existing stop order. This is constrained batching, not an optimal route solver. Capacity is a ceiling, not a target that delays departure. Preparation uses existing preparing/ready states and readyAt.

Manual flow: select orders, zone and courier, review the road estimate, then confirm offers. Preview does not reserve capacity. Confirmation recomputes routes and atomically rechecks payment, ownership, eligibility, revisions and capacity. Existing delivery controls allow withdrawal/reassignment before pickup, with a recorded reason.

Rider flow: view trip orders, accept individual offers or all pending offers atomically, mark arrival per order, collect all ready orders and follow the stop sequence. First pickup closes the trip to additions. Decline, expiry, reassignment and completion release only the affected slot; the last release closes the trip. Orders are never automatically cancelled when dispatch cannot find capacity.

## Deployment

1. Keep `COMMERCE_BATCHING_ENABLED=false` while deploying all API and worker processes. Do not run older dispatch workers alongside enabled batching: older versions do not understand trip reservations.
2. Use a MongoDB replica set or supported sharded deployment for transactions. Prepare indexes explicitly with `node scripts/commerce-delivery-indexes.cjs --plan`, then `--apply`, then `--check`, using explicitly configured `COMMERCE_MONGODB_URI` and `COMMERCE_MONGODB_DB` for the intended database. No index drop or user-data cleanup is required. Keep the existing single-delivery unique reservation index; the new Trip unique partial index protects one active trip per courier.
3. Configure existing server Google Routes credentials (`COMMERCE_GOOGLE_ROUTES_API_KEY`). Configure restricted browser `VITE_GOOGLE_MAPS_API_KEY` with Maps JavaScript and Geocoding enabled; rebuild the frontend after changing build-time configuration.
4. Enable delivery, manual dispatch and routing flags before `COMMERCE_BATCHING_ENABLED=true`. Automatic processing also requires the existing auto-dispatch flag and merchant setting. New courier/zone auto switches default OFF; assign allowed zones and deliberately set courier capacities.
5. Pilot one outlet with capacity 2. Exercise real GPS, road routing, two rider sessions accepting concurrently, expiry, process restart, manual reassignment, pickup, PIN delivery and slot release before widening rollout. Check persisted merchant/rider notices and recovery alerts.
6. To pause new batching, disable its flag. Existing trip acceptance and lifecycle endpoints remain available to finish work. Drain active trips before rolling code back to a version without trip support.

## API surface

All merchant endpoints use the existing Commerce API mount, workspace scope and delivery-management permissions. Zone/trip listings are paginated. Mutations validate input and optimistic revisions.

- `GET/POST /delivery-zones`; `PATCH /delivery-zones/:id`
- `PATCH /couriers/:id/batching`
- `GET /delivery-trips`
- `POST /delivery-trips/preview`; `POST /delivery-trips/assign`
- `POST /rider/trips/:id/accept` (authenticated assigned rider)
- Existing delivery actions and rider polling expose trip state without breaking the single-order response.

## Cost, reliability and verification limits

Road checking is bounded to 10 orders: at most 5 matrix requests / 110 elements per trip check, with 2 concurrent calls. Preview and confirmation each perform their own check. Automatic selection also ranks a configurable shortlist and may check multiple candidates, with one immediate retry for snapshot conflicts. Monitor provider quotas and cost; Google content is not persisted by the batch checker.

Notifications reuse durable in-app notices, sockets and polling. This change does not introduce email, WhatsApp or mobile background push delivery.

Local validation: 273 backend Commerce tests and 36 frontend Commerce tests passed. New tests cover eligibility, tenant/outlet boundaries, bounded shortlist structure, capacity conflicts, atomic acceptance, expiry/restart idempotence, decline/reassignment, payment failures, road outage, detours and stop sequencing. Database/provider behavior is mocked in these focused tests; actual MongoDB transaction races, Google responses, map interaction and mobile/browser end-to-end acceptance still require staging verification. No live database indexes, flags or deployment were changed during implementation.

Primary changed files: delivery/models.js, domain.js, routing.js, batching.js, service.js, autoDispatch.js, routes.js; scripts/commerce-delivery-indexes.cjs; delivery batching/routes tests. Frontend: BatchingManagement.tsx, ZoneMap.tsx, LocationPicker.tsx, DeliveryManagement.tsx, CommercePage.tsx, RiderPage.tsx and Commerce render tests.

Final checks: frontend `npm run build` passed (TypeScript and Vite), with bundle-size/plugin-timing warnings. Backend changed delivery modules passed `node --check`; offline index plan and both repositories' `git diff --check` passed. Neither package defines a lint command; no lint result is claimed. Frontend VM-module tests emit an experimental Node warning but return exit code 0. Deployment remains pending staging acceptance.
