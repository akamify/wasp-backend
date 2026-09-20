# Phase 2: Geo and routing assistance

Implemented behind `COMMERCE_ROUTING_ENABLED=true`, in addition to the existing
delivery flag. Enable it only after the Phase 1 end-to-end acceptance checklist
has passed in your deployment. Local code/tests do not establish that acceptance.
No environment flags, credentials, remote indexes or live routes were changed or
called during implementation.

## Merchant flow

In Live Dispatch, open a paid delivery awaiting a rider. Choose **Nearest Pickup**,
**Nearest Customer** or **Suggested Rider**, then **Get recommendations**.
Recommendations do not load automatically during polling. Select a candidate,
then separately confirm **Offer delivery to rider**. Rider acceptance is still
required. An unavailable Routes API never removes the existing manual picker.

**Nearest Pickup:** MongoDB selects riders nearest the accepted pickup; Google
road pickup ETA ranks that shortlist.

**Nearest Customer:** MongoDB selects riders nearest the customer's confirmed
location, constrained to the configured radius around the accepted pickup.
Google direct rider-to-customer ETA ranks the shortlist. This is a proximity aid:
the rider still must collect from the order's original restaurant.

**Suggested Rider:** MongoDB shortlists nearest pickup riders. Score is
`max(rider-to-pickup seconds, remaining preparation seconds) + pickup-to-customer seconds`.
Ties use pickup ETA then stable courier ID. The second leg is a current road
estimate, not a promised delivery time or a prediction of traffic after food
preparation. Suggestion is the best of the shortlist, not a global optimum.

All modes preserve the same merchant, order, outlet and manual offer workflow.

## Configurable defaults

Workspace managers with `commerce.delivery.manage` can save these in Dispatch
Settings. Viewers cannot edit. Revision checks reject conflicting saves.

| Setting | Default | Allowed range |
| --- | --- | --- |
| Pickup radius | 8,000 metres | 100–50,000 metres |
| Location freshness | 60 seconds | 15–300 seconds |
| Maximum GPS uncertainty | 100 metres | 1–1,000 metres |
| Route shortlist | 5 riders | 1–20 riders |
| Offer lifetime | 20 seconds | 10–120 seconds |

Values must be integers. They affect future recommendations and offers; existing
offer expiry stays as originally recorded. Radius, freshness and uncertainty are
rechecked on manual offer creation, including riders selected without routing.
Rider GPS ingest uses the configured freshness. Foreground GPS frequency remains
separately controlled by the existing `COMMERCE_RIDER_GPS_SECONDS` setting.
If routing is disabled, Phase 1 defaults apply; saved Phase 2 settings remain in DB
for re-enablement.

## Storage and query design

`CommerceCourier.geoPoint` is a GeoJSON Point in **longitude, latitude** order.
An authenticated GPS upload writes it atomically with accuracy and timestamps.
Legacy records are intentionally not backfilled from old locations: riders become
geo-discoverable after a fresh upload. The ISO timestamp validator now accepts the
JSON string the rider app actually sends, without relaxing numeric validation.

Explicit indexes add `{workspaceId: 1, geoPoint: "2dsphere"}` and a unique workspace
index for `CommerceDeliverySettings`. Phase 1 readiness excludes these new indexes;
routing readiness checks them and fails closed when missing. The index script
does not drop indexes or rewrite courier data.

`$geoNear` is first, using `key: geoPoint` and an explicitly cast workspace ID.
Its query filters active, online, unassigned, allowed-outlet riders with fresh,
non-future capture/receipt timestamps and acceptable accuracy **before** `$limit`.
Customer mode combines geo proximity with a pickup-centred `$geoWithin` constraint.
Geo reads have a three-second server deadline. Only the limited candidate fields
are returned; phone, user ID, customer address text and payment data never go to Google.

## Google Routes requests and failures

Use the backend-only `COMMERCE_GOOGLE_ROUTES_API_KEY`, with Routes API enabled,
billing configured, server IP/API restrictions and appropriate quota limits.
This is separate from the frontend Maps JavaScript browser key; never put the
Routes key in a `VITE_` variable.

The existing Axios dependency calls `computeRouteMatrix` over HTTPS with a field
mask, no redirects, an eight-second timeout and bounded response size. Riders are
grouped by vehicle: car `DRIVE`, motorcycle `TWO_WHEELER`, bicycle `BICYCLE`.
Traffic-aware routing is requested for car/motorcycle. Unsupported regional routes
remain unavailable instead of silently pretending another vehicle's ETA applies.

For N shortlisted riders across G vehicle types, there are at most G requests and
`2 * (N + G)` matrix elements: each group's rider origins plus pickup, and pickup /
customer destinations. For the default five riders, at most three calls / sixteen
elements; with twenty riders, at most forty-six elements. Empty shortlist = zero
provider calls. Riders outside the shortlist are never sent to Google.

A durable conditional timestamp on the delivery limits repeated routing requests
to one every ten seconds across processes/tabs. There are no automatic provider
retries and no persistent cache of Google route content. API responses use the
delivery router's `no-store` policy; results exist only in the current UI session.
Standard authenticated delivery request limits also apply.

Out-of-order matrix elements are matched by origin/destination index. Missing,
malformed, failed and unreachable elements never become zero or fabricated ETAs.
Partial failures show a warning and only rank usable candidates. Google fallback
estimates are labelled. After provider I/O, delivery revision and candidate state
are reread; changed GPS, busy/suspended riders and stale locations are dropped.
Results expire within fifteen seconds or the GPS freshness deadline, whichever
comes first. Confirmation still revalidates eligibility transactionally.

## Deployment and verification

Local verification (2026-09-17): **239 backend Commerce tests passed**, **31 frontend
Commerce tests passed**, TypeScript and production Vite build passed. Thirteen
delivery/index-script syntax and whitespace checks, both repository diff checks,
and the offline geospatial index plan passed. No lint command is configured.
The build retains CSS gradient syntax and large application chunk warnings.
The routing adapter, failure handling and aggregation shape were tested with
controlled mocks, not a live Google project or MongoDB replica set.

1. Complete Phase 1 end-to-end verification, including live-equivalent merchant
   capture, worker recovery, rider acceptance and PIN completion on staging.
2. Keep routing disabled while deploying this code. Run the updated explicit
   index plan, inspect it, then apply/check against the intended database:

   ```powershell
   node scripts/commerce-delivery-indexes.cjs --plan
   # Explicit COMMERCE_MONGODB_URI and COMMERCE_MONGODB_DB are required:
   node scripts/commerce-delivery-indexes.cjs --apply
   node scripts/commerce-delivery-indexes.cjs --check
   ```

3. Configure the server Routes key and enable `COMMERCE_ROUTING_ENABLED` on API
   processes after index checks pass. Existing delivery/manual dispatch flags
   still control delivery and new offers. Set merchant values in Dispatch Settings.
4. Have riders upload fresh GPS. Verify `{workspaceId, geoPoint}` index use with
   an execution plan for the actual tenant and geographic distribution, including
   customer-centred shortlisting. No real MongoDB execution plan was available locally.
5. Check three modes on known local roads, vehicle coverage, stale/inaccurate GPS,
   empty results, settings revision conflicts, provider timeout/quota errors,
   concurrent recommendations and two dispatchers racing for one rider. Verify
   selection never creates an offer until the merchant explicitly confirms.
6. Confirm visible Google Maps attribution and that public Terms/Privacy cover
   use of Google Maps services and transfer of routing coordinates before release.

Automated checks use mocked provider/Mongo operations; they do not replace real
`2dsphere` execution, billable Google API or mobile browser acceptance. No dependency
installation, deployment or database mutation was performed by the implementation.

## Affected files and official references

Backend: delivery `models.js`, `routingSettings.js`, `routing.js`, `googleRoutes.js`,
`domain.js`, `service.js`, `routes.js`, `validators.js`, `readiness.js`, explicit
delivery index script and focused tests. Frontend: `RoutingAssistance.tsx`,
`DeliveryManagement.tsx` and render tests.

- [MongoDB $geoNear](https://www.mongodb.com/docs/manual/reference/operator/aggregation/geonear/)
- [Google route matrix guide](https://developers.google.com/maps/documentation/routes/compute_route_matrix)
- [Google REST request/response contract](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)
- [Google attribution and content policies](https://developers.google.com/maps/documentation/routes/policies)
