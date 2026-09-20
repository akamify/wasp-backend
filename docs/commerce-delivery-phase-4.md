# Phase 4: Reliability and operational safety

## Resulting behavior

Automatic dispatch never cancels an order. An empty eligible shortlist moves the
delivery into `awaiting_manual_assignment` immediately. Temporary routing or
dispatch failures retain the durable one-minute retry lease, with up to five
rounds. Final failure moves to `awaiting_manual_assignment`, pauses automation
and persists a merchant notice in the same database transaction. Crashed workers
whose final attempt did not finish are handled by the next expired-lease scan.
There is no order/payment mutation in this fallback.

An expired or declined automatic offer releases its rider and makes the next
rider attempt due immediately (subject to the existing routing cooldown and
worker capacity). Previously offered riders remain excluded for that cycle.
With automation OFF/paused, an expired or declined offer enters manual assignment
instead. Missing rider records also require manual intervention. Each expiry is
processed independently: one failure does not stop later records in its batch.

Manual takeover and reassignment enter the same explicit manual state. Merchant
can obtain recommendations, offer to an eligible rider or resume automation from
that state. Resume resets the bounded cycle; merchant OFF/MANUAL still prevents
automatic offers. Post-pickup reassignment remains prohibited.

## Atomic assignment and recovery

- One delivery record per workspace/order is enforced by the existing unique
  index. Its status and revision are conditionally updated within a transaction.
- A unique partial `activeCourierId` index prevents two delivery records from
  reserving one rider. Offers reserve `Courier.currentDeliveryId` transactionally.
- Acceptance now checks both reservation pointers and revalidates active/online
  status, outlet permission, vehicle, fresh accurate GPS and pickup radius. It
  writes the courier in the same transaction as the delivery and notices, fencing
  GPS/access edits and concurrent reservation changes. Only the offered rider's
  authenticated account can accept. Expired/replaced offers cannot be accepted.
- Fallback checks delivery revision, attempt number and state. A stale worker
  cannot overwrite a later lease, merchant takeover or accepted offer.
- Notifications are durable `CommerceDeliveryNotice` records with unique keys.
  Notification persistence and lifecycle changes commit together. If persistence
  fails, the transaction rolls back and the durable lease/expiry scan retries.
- Socket reconnect and authenticated polling reload current state/notices from
  the database; neither depends on a successfully delivered in-memory event.
  Alerts are available in Live Dispatch and Reports & Activity. Live Dispatch
  displays recent alerts from the latest ten notices; delivery status remains
  authoritative for unresolved work. These are in-panel alerts, not SMS/email
  or guaranteed background push notifications.
- Existing webhook signature verification, workspace/event uniqueness, immutable
  provider correlation and transaction-based order creation remain unchanged.
  Duplicate Meta/Razorpay/native webhook regression tests still pass. Rider
  acceptance uses authenticated APIs, not payment webhooks.
- Structured `delivery_auto_retry` and `delivery_expiry_retry` log events expose
  retry counts without upstream errors, GPS or credentials. Monitor these and
  existing failed worker jobs/queue age in the deployment's log/queue monitoring.
  A complete database outage cannot persist merchant alerts until storage recovers.

## Rollout and verification

No new index or data backfill is required beyond the Phase 3 explicit index plan.
The delivery status enum now includes `awaiting_manual_assignment` via domain
states. Deploy compatible API, worker and frontend together: stop old auto workers
during rollout so they do not continue the Phase 3 pause-only failure behavior.
Existing historical paused records remain usable through manual controls; their
status changes when an authorized action is performed. No live records were
rewritten in this session.

Keep the existing Phase 3 automation flags OFF until staging acceptance. Verify
the replica-set transaction/index prerequisites with the existing explicit index
script. Exercise two real workers, two orders competing for one rider, two rider
acceptances, expiry/acceptance racing, lost responses, disconnect/reconnect,
worker kill/restart, rejected Google calls, failed notice persistence and restored
storage. Inspect MongoDB query plans against representative data volumes.

Local checks: 259 backend commerce tests and 34 frontend tests passed; TypeScript
and the production Vite build passed, with the existing large-chunk warning.
Fifteen backend delivery/worker/index-script syntax checks, the offline index plan
and both repositories' diff checks passed. No lint script is configured.
Concurrency and transaction failure tests use mocks: real MongoDB concurrency,
Redis restart, Google outage and mobile acceptance were not executed. No deploy,
live flag change, database mutation or external notification was performed.

Changed files: backend delivery `domain.js`, `service.js`, `autoDispatch.js`,
`routing.js`, `routes.js`; tests `delivery.test.cjs`, `delivery-auto.test.cjs`,
`delivery-routing.test.cjs`, `delivery-routes.test.cjs`; frontend
`DeliveryManagement.tsx`, `ui.tsx`, `tests/commerce-render.test.mjs`; this runbook.
