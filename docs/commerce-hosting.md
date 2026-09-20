# Commerce hosting and acceptance

Prepared 2026-09-15 for the repository's existing VPS workflows. This is a deployment runbook, not evidence of a deployment or live payment. Stage reports describe the payment and recovery contracts; [Stage 7](commerce-stage-7.md) records native-payment restrictions.

## Implemented customer flow

1. Merchant connects its WhatsApp account and a dedicated, initially empty Meta catalog in Commerce Settings. Create the catalog in Meta Commerce Manager first; AIWizChat connects that catalog and manages its products. Enable catalog visibility and cart.
2. Add products in Commerce Products. Wait for successful Meta synchronization/review before sending them.
3. Merchant connects its own Razorpay account with manual API keys or supported OAuth. Test/live credentials remain separate. Complete merchant identity and payment-webhook verification; entering credentials alone is insufficient for checkout readiness.
4. In an open customer conversation, choose **+ → Catalog → Send catalog**, or select synchronized products and send them. Opening the picker does not itself send a message. Changing customer/workspace closes the picker and disposes its requests.
5. Customer submits a WhatsApp cart. It becomes an order requiring merchant review. Open the order, complete pickup/delivery details, review the authoritative quote and approve it.
6. Create a hosted payment request, then select **Send payment request on WhatsApp** directly on the order. The customer pays on the merchant's Razorpay link. Native Review and Pay is a separate, gated live option; creating it includes its send attempt and does not expose another send button.
7. Provider verification records captured payment, inventory and confirmation. Inspect notification/delivery status separately. Capture is not proof of bank settlement.

There is no automatic checkout immediately after cart submission. Current review and stock/price checks remain intentional. Ambiguous sends are not automatically repeated; inspect the customer inbox before starting another send intent.

## Release preparation

Both repositories contain existing uncommitted/untracked Commerce work. Review and include the complete Stage 1–7 change set and this increment in the deployment commits. Do not deploy only the tracked diff or include unrelated local work unintentionally.

The existing workflows use Node **22.14.0** and `npm ci`; use the workflow runtime for the first acceptance run. From the respective repository roots:

```sh
# Backend
npm ci
npm run test:commerce
npm run commerce:indexes -- --plan
npm run commerce:hosting -- --plan
npm run build

# Frontend (separate repository)
npm ci
node --experimental-vm-modules --test --test-concurrency=1 tests/commerce-*.test.mjs
npm run build
```

The backend build is currently a no-op. The frontend build includes TypeScript checking. No executable lint command is configured. The Windows sandbox test invocation used locally disables test-process isolation; CI uses separate test processes.

Both workflow deployment jobs require their verification job. They currently invoke remote files that are absent from these local repositories:

- Backend: `/root/wasp-backend/deploy.sh`
- Frontend: `/root/wasp-frontend/scripts/deploy.sh`

Inspect those actual host scripts before release. Verify that they deploy the reviewed commit, install locked dependencies, preserve host configuration and persistent files, restart both backend processes, and fail on unsuccessful checks. Their existence or correctness has not been verified here. Backend SSH uses `SSH_PRIVATE_KEY`; frontend uses `VPS_SSH_KEY`; both also use `VPS_HOST`, `VPS_USER`, `VPS_PORT` repository secrets.

## Runtime configuration

Run API (`node index.js`) and worker (`node worker.js`) as separately supervised processes with automatic restart. Both must use the same intended MongoDB database, Redis, encryption/lookup keys and Commerce flags. API availability alone does not demonstrate worker health.

Required configuration is enumerated without values by `npm run commerce:hosting -- --plan`. It includes production `NODE_ENV`, `MONGODB_URI`, `REDIS_URL`, a strong `JWT_SECRET`, the existing base64 32-byte `CREDENTIALS_ENCRYPTION_KEY`, lookup secret, Meta app identity/secret/verification token, explicit `META_GRAPH_VERSION` and HTTPS `FRONTEND_BASE_URL`.

Run `npm run commerce:hosting -- --check` under the intended host environment. It validates configuration shape without loading `.env`, connecting to services or printing secret values. A configuration PASS does **not** imply checkout is enabled or credentials/services work. Check the separate `checkoutEnabled` and `liveCheckoutEnabled` output fields.

To load an explicitly chosen environment file, Node supports:

```sh
node --env-file=/secure/path/commerce.env scripts/commerce-hosting-check.cjs --check
```

Use the host's actual secure path; do not commit this file. Node's existing process variables take precedence over `--env-file`. Separately, this application's `loadEnv()` loads repository `.env` then overrides it with `.env.local`. Ensure the preflight and both running processes use the same effective values, including that override; checking a different file does not validate the deployment. See [Node environment-file documentation](https://nodejs.org/api/cli.html).

For staging, enable catalog/order/gateway/payment capabilities and test checkout, keeping live/native gates off:

```text
COMMERCE_CATALOG_ENABLED=true
COMMERCE_ORDERS_ENABLED=true
COMMERCE_GATEWAY_ENABLED=true
COMMERCE_PAYMENTS_ENABLED=true
COMMERCE_CHECKOUT_ENABLED=true
COMMERCE_LIVE_CHECKOUT_ENABLED=false
COMMERCE_NATIVE_PAYMENTS_ENABLED=false
COMMERCE_RAZORPAY_OAUTH_ENABLED=false
```

Enable OAuth after completing the dedicated `COMMERCE_RAZORPAY_OAUTH_TEST_*` or `COMMERCE_RAZORPAY_OAUTH_LIVE_*` settings (client ID/secret, registered HTTPS redirect URI, webhook secret). Manual API-key support does not require the OAuth flag. Configure merchant credentials in the authenticated application, not as a shared platform gateway. After infrastructure checks, initialize workspace order/payment settings and enable the required workspace capability. Restart API and worker after flag/config changes.

## Database, routing and workers

- MongoDB must support transactions (replica set or sharded cluster). Redis must be available with `DISABLE_REDIS` off.
- Supply `COMMERCE_MONGODB_URI` and `COMMERCE_MONGODB_DB` explicitly to `npm run commerce:indexes -- --check`. This verifies topology and declared indexes without changing them. Resolve missing indexes using the existing reviewed `--apply` plan as an operator-controlled database change; do not silently run it at application startup. No index apply was performed here.
- Serve frontend `dist/` through the production static host with SPA route fallback. Vite's development proxy does not configure production routing. `vite preview` is not a production server: [official Vite deployment guide](https://vite.dev/guide/static-deploy).
- Route the intended `/api` paths and Socket.IO transport to the API. Preserve webhook raw request bodies and expose the configured Meta/Razorpay callback URLs over valid HTTPS. Configure CORS and auth-cookie domain for the actual frontend/API domains; the repository's default cookie domain is `.aiwizchat.com`.
- Probe `/api/health`, then authenticated Commerce access and operations. The health endpoint only returns basic API liveness; verify actual MongoDB/Redis connectivity and running catalog, order-intake and payment-recovery workers independently.
- Verify worker queues progress with a staging product sync, cart intake and payment reconciliation. Inspect failures without logging credentials or customer payloads. Keep workers running for outstanding payments even when new-checkout gates are off.

## Acceptance before live customer use

Run on isolated staging infrastructure, followed by a controlled merchant pilot:

1. Browser login, tenant switching, role denial, product add/sync and **+ → Catalog** send. Verify the recipient sees the correct catalog and cart reaches the intended workspace exactly once.
2. Merchant review, hosted request creation/send, successful payment and verified order confirmation. Repeat with two distinct merchant accounts and verify each provider account owns its own checkout/payment.
3. Failed/expired payment, duplicate/out-of-order webhook, closed reply window, stock contention, worker restart after dispatch timeout and provider disconnect. Unknown operations must remain visible and must not produce duplicate charges.
4. Refund verification and order fulfillment notifications. Verify paid status is not reversed by an old callback and that refund does not silently restock goods.
5. If native payments are required, complete Meta-to-merchant gateway configuration and the exact operator binding allowlist described in Stage 7. Test the intended Graph version and accept the documented pending-cancellation limitation before enabling live/native gates. Configuration checks alone do not prove native eligibility or delivery.
6. Confirm CI success for the deployment commits, actual host scripts, TLS/callback routing, database indexes, API and worker health. Record the release and a recovery/rollback procedure.

For payment rollback, stop new checkout using its dedicated flag while retaining payment processing, recovery workers and original merchant/channel credentials for outstanding attempts. Do not delete payment records or replace historical credentials to clear an uncertain checkout.

## Verification record

Local regression tests: **206 backend and 22 frontend passed** after the UI changes. After adding replica-set seed-list/SRV URI coverage to the preflight, its three tests were rerun and passed without a connection.

- Frontend `npm run build`: TypeScript and Vite passed. Existing outdated CSS-gradient and large main-chunk warnings remain. Inbox Commerce is a separate 4.74 KB chunk (1.93 KB gzip); the Commerce page is 43.37 KB (10.96 KB gzip).
- Backend no-op build passed; direct `node --check` passed for 111 Commerce JavaScript/test/model/script files.
- Hosting offline plan passed. Offline index plan reports 12 collections and 43 declared indexes; no connected check/apply was run.
- Both repositories passed `git diff --check`; this increment's new hosting files and Commerce frontend files passed explicit trailing-whitespace checks.
- No dependency, schema or environment-file changes were made in this increment. No executable lint tooling is configured.

Files changed in this increment (separate repository roots):

- Frontend: `src/modules/conversations/components/AttachmentMenu.tsx`, `InboxComposer.tsx`; `src/modules/conversations/views/ConversationWorkspace.tsx`; `src/modules/commerce/InboxCommerce.tsx`, `OrdersPage.tsx`, new `PaymentRequestButton.tsx`; `tests/commerce-render.test.mjs`.
- Backend: `package.json`; new `scripts/commerce-hosting-check.cjs`, `src/modules/commerce/tests/hosting-check.test.cjs`, and this runbook.

Interactive browser verification is blocked by the browser tool runtime error `codex/sandbox-state-meta: missing field sandboxPolicy`. No live provider requests, WhatsApp messages, database index apply or deployment were performed. Connected database/Redis tests, merchant acceptance and host verification remain required. **GO for staging preparation; NO-GO for unrestricted live activation until acceptance passes.**
