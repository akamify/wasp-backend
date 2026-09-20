# Business Groups: connected workspace reporting

## Scope

The sidebar entry **Business Groups** opens `/app/business-groups`. Each merchant user can own one named reporting group with up to 100 workspace links. No new Meta, Maps or Razorpay credentials are needed. Existing WhatsApp, catalog, gateway, payment and delivery integrations are not modified.

1. Create a reporting group.
2. Select an owned workspace and connect it immediately.
3. For another owner's workspace, obtain its workspace ID and request access. No reporting data is available while pending.
4. The target owner opens Business Groups → Workspace approvals, selects their workspace, verifies the requesting owner's account ID, and approves or rejects. This is an in-app inbox; email/WhatsApp invitations are not sent.
5. Either owner can revoke access. A fresh request has a fresh request ID; stale approval actions cannot approve it.

The workspace owner is resolved using `ownerUserId || ownerId`, matching the existing workspace permission service. Ordinary workspace members and platform admin accounts cannot approve requests through these routes. Linking grants the group owner aggregate reporting and a restricted order list; it does not grant order-editing, messaging, catalog, credentials, payment, refund or delivery permissions.

## Reporting definitions

- Orders: received during the selected UTC interval `[from, to)`; default 30 days, maximum 366 days.
- Paid orders: those orders whose current payment status is captured. Each order counts once, irrespective of extra payment captures.
- Completed orders: those orders whose current order status is completed, including pickups. This is not a delivered-at event count.
- Captured amount: verified captured payment records first created in AIWizChat during the interval, grouped by workspace and currency. Existing recovery intentionally leaves `capturedAt` null, so this feature does not invent a provider capture timestamp. Captures include overpayments; this is not settlement income.
- Refunded amount: current recorded refunded amounts on those captured payment records, including refunds recorded after the selected period. This is not a refund-event date report.
- Unique ordering numbers: distinct customer numbers on orders received in the interval.
- Existing contact numbers: distinct saved Contact numbers across authorized workspaces, all time. Contact records have no payment environment field, so this count does not change with Test/Live.
- Number deduplication trims surrounding whitespace and an optional leading `+`; it does not infer country codes, merge contacts, or expose raw customer numbers.
- Recent orders: 25 per page with cursor pagination; no customer names, phone numbers, encrypted addresses, notes or gateway credentials are returned.

Test/Live are separate for order/payment metrics. Reports reflect database state as queries execute and are not a transactionally frozen accounting ledger. The page shows combined captured/refunded totals separately for each currency and a last-updated timestamp.

The first order page automatically refreshes 30 seconds after the previous request completes. Polling is optional, skips hidden/offline tabs, resumes when the tab becomes visible/online, and pauses on older order pages. Requests do not overlap; leaving the page or changing filters aborts the old request and discards stale responses. A failed refresh clears the old report instead of presenting it as current. This is periodic refresh, not instantaneous WebSocket delivery. Orders must have been persisted by the existing commerce ingestion flow and fall inside the selected date/environment filters. Link all four source workspaces (including the dashboard owner's workspace if its orders are required) to see all four panels together. Pending/revoked connections do not contribute data.

## Authorization and concurrency

New `/business-groups` routes use existing authentication but do not trust a client workspace header to establish reporting scope. The authenticated user's ID selects their group. The server resolves active grants and current workspace ownership on every report request. Suspended/deleted workspaces and ownership mismatches are excluded. A second scope check discards a report if authorization changes while aggregation is running. Already displayed/downloaded information cannot be recalled after revocation.

Group documents use the owner's user ID as `_id`, giving one group per owner without a second uniqueness requirement. Links are bounded within that document. Link creation/replacement uses revision compare-and-swap; approval/rejection/revocation use a conditional atomic update matching workspace, request ID and eligible status. Concurrent edits return HTTP 409 for refresh/retry. The link stores its latest request and decision timestamps/actor; this is not a permanent historical audit ledger.

Reads are bounded, reports have a 10-second per-query MongoDB timeout, and aggregations start with authorized workspace and applicable date/environment filters. Responses use `Cache-Control: no-store`. New endpoints have authenticated-user request limits; the memory-backed limiter is per process, consistent with the existing limiter architecture. A distributed abuse budget is a future operational enhancement for multi-instance deployments.

## Deployment

Deploy backend and frontend together. No `.env` changes or external provider setup are required for this feature.

Before enabling usage, create/check additive indexes with an explicitly configured database target. The script does not load `.env`, delete data, drop indexes, or use `syncIndexes`.

```powershell
node scripts/business-group-indexes.cjs --plan
# Set COMMERCE_MONGODB_URI and COMMERCE_MONGODB_DB explicitly for the intended database.
node scripts/business-group-indexes.cjs --apply
node scripts/business-group-indexes.cjs --check
```

The plan adds the BusinessGroup inbox index and order/payment reporting indexes. The existing Contact workspace index is reused. Verify execution plans and latency against realistic staging data before production; totals can scan many matching records even with workspace/date indexes.

Staging smoke test: use two owner logins and one ordinary member. Verify immediate own-workspace linking; pending cross-owner requests; member denial; owner approval; Test/Live isolation; shared-number deduplication; capture/refund definitions; pagination; revoke during a report; stale approval; concurrent link requests; and unchanged existing catalog, checkout and gateway screens.

## Local checks

```powershell
node --test --experimental-test-isolation=none src/modules/business-groups/tests/*.test.cjs
node --test --experimental-test-isolation=none src/modules/commerce/tests/*.test.cjs
# From wasp-frontend:
node --test --experimental-test-isolation=none tests/business-groups.test.mjs
npm run build
```

Tests cover authorization, input validation, conditional write contracts, link limits, scope revocation, reporting query boundaries, HTTP routes and rendered UI actions. Database calls are mocked in local tests; these do not replace actual MongoDB concurrency, execution-plan or browser end-to-end staging verification.

## Official references consulted

- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): least privilege and authorization on every request.
- [MongoDB `$match`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/): early filtering and index use.
- [Meta's sample tech-provider application](https://github.com/fbsamples/business-messaging-sample-tech-provider-app): WhatsApp account onboarding remains separate from this AIWizChat reporting relationship.
