# Phase 3: Smart Auto Dispatch

## Behavior

Merchant settings now support SMART (recommended default), NEAREST_PICKUP,
NEAREST_CUSTOMER and MANUAL. Auto Dispatch defaults to OFF for both existing and
new merchants. No feature flag or merchant setting was enabled during implementation.

SMART ranks by seconds:

`max(courier -> outlet road ETA, remaining preparation) + handover allowance + outlet -> customer road ETA`

Remaining preparation is clamped to zero for a ready/past-ready order. Handover is
configurable from 0 to 1800 seconds, default 120. Nearest Pickup ranks by pickup
road ETA; Nearest Customer ranks by direct rider-to-customer road ETA while still
requiring pickup at the accepted outlet. Ties use pickup ETA, then rider ID.
These are current traffic estimates, not guarantees of future traffic after preparation.

Eligibility is server authoritative: same workspace, allowed outlet, active,
online, no current delivery, no conflicting active reservation, allowed vehicle,
recent captured AND received GPS, acceptable uncertainty, and pickup radius.
The current product has no per-order vehicle requirement. The new merchant
`allowedVehicles` setting controls permitted vehicles (motorcycle/bicycle/car,
all three initially allowed); this does not invent parcel capacity requirements.
Conflicting offers/deliveries are excluded before the configurable geo shortlist
limit, and checked again before offering. Automatic attempts exclude riders
already offered this delivery during the current automatic cycle.

OFF: merchant requests recommendations, selects a rider, then confirms an offer.
ON: the worker requests bounded road estimates and offers to the first ranked
eligible rider. Rider acceptance remains mandatory; there is no forced assignment.
MANUAL suppresses automatic offers even if an older settings document has the
auto flag set. Switching the UI to MANUAL also clears the switch.

## Reliability and manual override

- Separate BullMQ `commerce.delivery.auto` scheduler checks every 5 seconds.
  Offer expiry recovery remains a separate existing job.
- Database scan returns at most 10 due deliveries from opted-in merchants per
  job, with a 3-second query deadline; two deliveries are processed concurrently.
- A majority-write conditional claim sets the next attempt one minute ahead.
  Duplicate workers cannot claim the same due record. Crashes recover after
  the lease time. Empty/failed routes and reservation races never invent an ETA.
- At most five automatic rounds run per delivery cycle. After exhaustion, a
  subsequent sweep pauses automation and persists a merchant notification.
  Each round uses the configured route shortlist, not every rider. Phase 2
  provider request deadlines and per-delivery routing cooldown still apply.
- Declined/expired offers release their rider using the existing transaction.
  The next due automatic round excludes previously offered riders. Existing
  offers preserve their original configurable expiry.
- Offer creation rechecks payment, refund issues, delivery revision, GPS,
  vehicle, pickup radius, active outlet and merchant, recommendation expiry and
  settings revision. Courier reservation, delivery update and notifications
  share a transaction. The existing unique activeCourierId index remains the
  last defense against two deliveries reserving the same rider.
- An automatic offer writes a fence on its settings document in the same
  transaction: turning OFF/changing settings conflicts with an in-flight offer.
  OFF stops future automatic offers; an offer committed before OFF stays valid.
- **Take manual control / withdraw offer** pauses the delivery and atomically
  withdraws a pending offer. Manual offering and reassignment also pause that
  delivery. **Resume automatic dispatch** clears its automatic cycle history
  and retry counter; workspace OFF/MANUAL still take precedence.
- Actions use commerce.delivery.manage, trusted workspace scope, strict request
  validation and revision checks. Riders cannot change automatic dispatch.
- Google route content is not persisted by this feature. Job results expose
  aggregate outcomes only; no keys, GPS, addresses or upstream errors are logged.

## Rollout

Phase 1/2 live acceptance is still a prerequisite. Apply/check the explicit index
plan against the intended staging replica set (never standalone MongoDB):

```powershell
node scripts/commerce-delivery-indexes.cjs --plan
# Set COMMERCE_MONGODB_URI and COMMERCE_MONGODB_DB for the intended database.
node scripts/commerce-delivery-indexes.cjs --apply
node scripts/commerce-delivery-indexes.cjs --check
```

The added index is `{status: 1, autoNextAttemptAt: 1, _id: 1}` on deliveries.
Models disable automatic index creation. Existing records require no GPS/history
backfill: missing automatic fields are treated as their safe defaults. Phase 1
readiness does not require this new index; automatic readiness does.

API and webhook worker require the existing delivery/manual/routing flags and
server-only Google Routes key. After staging acceptance, the additional opt-in
flag is `COMMERCE_AUTO_DISPATCH_ENABLED=true`. Restart the webhook worker to
register its scheduler. Each merchant must also save Auto Dispatch ON in
Ecommerce Management > Dispatch Settings. Saving ON requires routing indexes,
the new dispatch index and a configured Google key. Keep the flag false during
rollout until acceptance is approved. Turning it false stops automatic work;
manual offers and expiry recovery remain available under their existing flags.

Staging acceptance must exercise real Google routes and MongoDB transactions:
two workers/two orders competing for one rider; OFF/manual takeover during
Google I/O; settings/GPS changes during I/O; stale/inaccurate GPS, wrong vehicle,
foreign merchants/outlets, active offers; failed routes; decline/timeout/retry;
worker restart; exhausted attempts and resume; rider notification and acceptance.
Inspect aggregation explain plans and scan latency with representative merchant
and rider counts, especially the geo conflict lookup and opted-in delivery scan.

## Verification boundaries

Local verification on 2026-09-17: 251 backend commerce tests and 33 frontend
commerce tests passed. All 15 delivery/worker/index-script syntax checks, the
offline index plan and both repositories' `git diff --check` passed. Frontend
`npm run build` (TypeScript and Vite) passed after rerunning outside the sandbox
which initially blocked a Vite child process with `spawn EPERM`. Bundle-size and
plugin-timing warnings remain. Neither repository configures a lint script.

Changed implementation files: delivery `models.js`, `domain.js`, `routing.js`,
`routingSettings.js`, `readiness.js`, `service.js`, `routes.js`, `validators.js`,
new `autoDispatch.js`, and `src/infra/workers/webhook.worker.js`. Frontend changes
are `RoutingAssistance.tsx` and `DeliveryManagement.tsx`. Focused tests changed
in `delivery-auto.test.cjs`, `delivery-routing.test.cjs`, `delivery.test.cjs`,
`delivery-routes.test.cjs`, and frontend `commerce-render.test.mjs`.

Focused automated tests cover formula, strategy gates, bounded queries, lease
competition, retry/exhaustion, transactional offer guards, permissions and UI.
Mocked concurrency tests do not replace live replica-set concurrency acceptance.
No deployment, database mutation, real Google charge or live rider acceptance
was performed in this implementation session.

Official references consulted:
- https://www.mongodb.com/docs/manual/core/transactions/
- https://www.mongodb.com/docs/manual/reference/operator/aggregation/geonear/
- https://developers.google.com/maps/documentation/routes/compute_route_matrix
