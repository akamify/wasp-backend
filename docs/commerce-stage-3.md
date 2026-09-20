# Merchant-owned Commerce: Stage 3

Updated: 2026-09-10. Stage 3 backend implementation is complete locally, following the updated Manual API Keys + OAuth scope. Frontend connection screens remain Stage 6. Live checkout and native WhatsApp payments are not enabled by this stage.

## What changed

Previously, Stage 1 provided gateway/session schemas but no executable merchant onboarding or token lifecycle. Stage 3 adds authenticated gateway APIs, a Razorpay adapter, encrypted OAuth sessions, refresh ownership, signed authorization-revocation handling and a maintenance job on the existing webhook queue. It adds no package dependency and does not change platform wallet/billing integration.

### Manual credentials

- The caller supplies explicit `test` or `live`, the matching Razorpay key ID and its secret. OAuth public keys, unknown request fields and environment mismatches are rejected.
- A read-only `GET https://api.razorpay.com/v1/payments?count=1` verifies resource access. Retrieved payment/customer data is discarded and never stored or returned.
- Both credentials are encrypted with the existing AES-256-GCM utility and an envelope bound to workspace, connection ID and field. DTOs explicitly allowlist safe status fields; keys and tokens are never returned.
- Only a masked key label is visible. A SHA-256 key-ID fingerprint prevents concurrent active reuse of the exact key. Active connections are unique by workspace/provider/environment. An existing active connection must be explicitly disconnected before replacement.
- A successful probe does **not** prove merchant account identity. Manual connections retain `identityVerified=false`, `webhookStatus=needs_setup` and `nativePaymentStatus=unverified`.

### OAuth lifecycle

- OAuth is separately gated and uses dedicated Commerce partner-client configuration for each environment. No wallet/billing Razorpay variable is a fallback.
- Start creates a 10-minute random state, stores only its hash, and encrypts the browser binding/configuration. A per-state Secure, HttpOnly, SameSite=Lax `__Host-` cookie binds the browser; concurrent tabs have separate cookie names.
- Callback requires the authenticated initiating user and matching browser cookie. It obtains workspace identity from the stored session and rechecks current membership/permission. It never trusts a callback workspace query or the user's newly selected workspace.
- State is consumed with an atomic expiry/unused check before exchanging the code. Denial, replay and expired state cannot exchange tokens. Authorization errors are not echoed.
- The provider request specifies `mode=test` or `mode=live` explicitly. The response's OAuth public key must match that mode. Merchant identity comes only from the provider's token response, with an active verified-account uniqueness constraint.
- Tokens are persisted in an unusable connection before a read-only probe. Successful activation requires a conditional write; revocation/disconnect during the probe cannot reactivate the connection. A failed initial probe leaves `status=error`, `lastErrorCode=verification_pending` and no credential-verification timestamp.
- Access and refresh tokens rotate in one conditional database update. A durable refresh ownership claim precedes network I/O. Only one caller can rotate a connection; the previous refresh token is never automatically retried after an uncertain result or expired worker lease.
- Expiry uses the provider's `expires_in`. Refresh is scheduled before expiry and can run on demand through the server-only merchant-authentication service. The existing BullMQ webhook worker checks up to 10 due connections every minute. No extra queue or process is introduced.
- Gateway/session lifecycle writes request majority acknowledgement with journaling and a 10-second write-concern timeout. Gateway readiness requires a replica set or sharded cluster and all declared gateway/session indexes. Readiness is read-only.

### Disconnect and revocation

`disconnect` is a **local disconnect**: it stops access through the active merchant authentication capability and preserves encrypted historical credentials and connection IDs. It does not revoke keys or the partner application at Razorpay. The merchant can revoke the application or rotate keys in the Razorpay Dashboard. Disconnect refuses an active token refresh; after an abandoned lease expires it can disconnect conservatively.

The public OAuth webhook accepts exact raw JSON bytes up to 64 KiB, verifies HMAC-SHA256, and processes only `account.app.authorization_revoked`. Its secret is dedicated to the partner application/environment, with optional previous-secret validation until an explicit expiry. Account ID, partner client ID and environment determine affected OAuth connections; payload workspace information has no authority.

The handler applies the idempotent revocation state change durably before acknowledging. Database failure returns an error so Razorpay can retry. Duplicate delivery cannot increment an already revoked record again. Authorizations after the event's second survive delayed delivery; an authorization in the same second is conservatively revoked. Keep API/worker clocks synchronized. This endpoint handles authorization lifecycle only; merchant payment webhooks and captured-payment processing remain Stage 5.

### HTTP and permissions

Management APIs require existing authentication, active workspace membership and `commerce.gateway.manage` (owner/admin by default, preserving existing permission overrides). Mutations require `application/json` and reuse existing connection rate limits. Audit records contain safe connection metadata only. OAuth callbacks are excluded from application access logs and use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. A targeted error boundary also sanitizes body-parser errors that might otherwise quote submitted credentials.

## API contract

Paths are relative to `/api/commerce/gateways`; the existing `/commerce/gateways` alias also applies. Management requests require authentication and `x-workspace-id`.

| Method/path | Input | Behavior |
| --- | --- | --- |
| GET / | None | Up to two active connections: test and live |
| GET /:gatewayId | Connection ID | Scoped current or historical status DTO |
| POST /manual | `environment`, `keyId`, `keySecret` | Read-only verification, encrypted connect |
| POST /oauth/start | `environment` | Authorization URL, expiry and browser cookie |
| GET /oauth/callback | `state` plus `code` or `error` | Authenticated browser callback; safe JSON result |
| POST /:gatewayId/verify | `revision` | Fresh credential probe, conditional status update |
| POST /:gatewayId/disconnect | `revision` | Local disconnect, preserve history |
| POST /oauth/webhooks/:environment | Raw signed provider JSON | Public authorization-revocation endpoint |

Manual example (use the merchant's actual credentials through a secret-safe client; these values are illustrative):

```json
{
  "environment": "test",
  "keyId": "rzp_test_example1234",
  "keySecret": "example-secret"
}
```

OAuth start returns a URL for top-level browser navigation. The browser must retain its AIWizChat login cookie and the new OAuth binding cookie on the API host. HTTPS is required, including in staging. A Bearer-only client must establish a browser login before following the provider redirect. Stage 3 returns safe completion JSON; it does not introduce a frontend callback page, arbitrary redirects or tokens in URLs.

`getMerchantAuthentication(workspaceId, gatewayId, environment)` is a server-only capability. Future payment callers must use the immutable connection stored on the checkout and independently enforce workspace/order permissions and payment readiness. This method permits only currently active, connected, environment-matching connections. Historical read-only reconciliation after disconnect needs a separate explicit Stage 5 path; it must never substitute a newly connected gateway.

## Configuration and staging preparation

No environment file, database, live gateway or production deployment was changed.

1. Review the offline index manifest: `npm run commerce:indexes`. It contains **12 collections and 34 indexes**. Three additive gateway indexes support refresh discovery, abandoned leases and account-based revocation. No schema migration or index application was run.
2. Use the existing operator script with explicit isolated staging `COMMERCE_MONGODB_URI` and `COMMERCE_MONGODB_DB` to apply/check reviewed indexes. Do not run the application's legacy database deduplication startup helper as a Commerce migration.
3. Configure a stable, securely managed `CREDENTIALS_ENCRYPTION_KEY` (base64, 32 decoded bytes). Changing it without a re-encryption procedure makes existing Commerce credentials unreadable.
4. Set `COMMERCE_GATEWAY_ENABLED=true` for API and worker in staging. All other Commerce live checkout flags remain off. Test manual onboarding using a merchant-owned test key first.
5. For approved partner OAuth integration, additionally set `COMMERCE_RAZORPAY_OAUTH_ENABLED=true`. For each enabled environment, replace `<ENV>` below with `TEST` or `LIVE`:

```text
COMMERCE_RAZORPAY_OAUTH_<ENV>_CLIENT_ID
COMMERCE_RAZORPAY_OAUTH_<ENV>_CLIENT_SECRET
COMMERCE_RAZORPAY_OAUTH_<ENV>_REDIRECT_URI
COMMERCE_RAZORPAY_OAUTH_<ENV>_WEBHOOK_SECRET
```

Register the exact HTTPS callback, for example `https://api.example.com/api/commerce/gateways/oauth/callback`, on the corresponding Razorpay partner client. Configure its `account.app.authorization_revoked` subscription to `/api/commerce/gateways/oauth/webhooks/test` or `/live`. Webhook secrets must be at least 16 characters. OAuth start refuses missing webhook-secret configuration; actual subscription delivery still needs staging verification.

Optional secret-rotation overlap:

```text
COMMERCE_RAZORPAY_OAUTH_<ENV>_PREVIOUS_WEBHOOK_SECRET
COMMERCE_RAZORPAY_OAUTH_<ENV>_PREVIOUS_WEBHOOK_SECRET_EXPIRES_AT
```

Use an explicit ISO timestamp with timezone for the expiry. Configure reverse-proxy, hosting and APM logs to exclude OAuth callback query strings and credential request/response bodies; the application logger change cannot configure those external systems.

Restart the existing webhook worker and verify its `commerce-gateway-maintain` scheduler in staging. Exercise token rotation, a lost response, database failover, membership removal, duplicate/same-second/delayed revocation, local disconnect and reconnection with actual provider test assets before production activation.

## Verification and practical limits

- **91/91 Commerce tests passed**, including 36 new gateway tests and all Stage 1/2 regressions. Tests cover real HTTP middleware authentication/permissions, request parsing/cookies, isolated provider contracts, encrypted credential scope, one-use OAuth state, refresh concurrency and ambiguous outcomes, account/mode mismatch, revocation ordering, majority-write query options and readiness gates.
- Command: `node --test --experimental-test-isolation=none src/modules/commerce/tests/*.test.cjs` on Node 22.14. Tests run inside the sandbox; database/provider adapters are simulated.
- All **60** applicable JavaScript/CommonJS files passed `node --check`. Offline index planning and `git diff --check` passed.
- `npm run build` passed; the backend's existing build script is a no-op. This backend has no configured typecheck or executable lint script. Frontend was not changed or rebuilt; the user's existing LandingNavbar edit remains intact.
- No real MongoDB replica-set/failover test, query execution plan, Redis scheduler integration, Razorpay sandbox/live request or production verification was performed. Readiness/index query tests do not replace those infrastructure checks.
- Manual keys cannot distinguish different keys belonging to the same merchant account. Exact-key reuse is prevented; verified account ownership for manual credentials remains a Stage 5 prerequisite before native eligibility or cross-workspace account deduplication is claimed.
- If token exchange succeeds but database persistence fails, a partner grant can remain on Razorpay without a connected local record. It is not blindly revoked because that could affect an existing connection for the same account. Check local status, then remove the unwanted grant in the merchant Dashboard before restarting when necessary.
- `verification_pending` or uncertain OAuth refresh requires inspection and local disconnect/reconnect. The implementation favors a recoverable blocked state over silently reusing a potentially invalid refresh token.
- Disconnect preserves credentials but does not implement post-disconnect token refresh/reconciliation or remote revocation. Those semantics must be considered with outstanding checkout attempts in Stage 5.
- OAuth partner access/approval, real registered callbacks, cookie behavior on deployment domains and revocation subscriptions are external prerequisites. API/OAuth connection success does not establish WhatsApp native payment eligibility.

**GO for Stage 4 implementation. NO-GO for production Commerce payment activation until later stages and staging/provider verification pass.**

## Stage 3 files

- `src/infra/database/CommerceGatewayConnection.js`
- `src/modules/commerce/domain/gateway.js`
- `src/modules/commerce/validators/gateway.validators.js`
- `src/modules/commerce/repositories/gateway.repository.js`
- `src/modules/commerce/services/gateway.service.js`, `gatewayConfig.service.js`, `gatewayReadiness.service.js`, `razorpayGateway.service.js`
- `src/modules/commerce/controllers/gateway.controller.js`
- `src/modules/commerce/routes/gateway.routes.js`, `gatewayHttp.js`
- `src/modules/commerce/tests/gateway-contracts.test.cjs`, `gateway-service.test.cjs`, `gateway-routes.test.cjs`, `gateway-repository.test.cjs`, `gateway-readiness.test.cjs`
- `app.js`, `src/core/routes/registerRoutes.js`, `src/infra/workers/webhook.worker.js`
- Stage 1 progress table and this report

## Official references reviewed

- [Razorpay API authentication](https://razorpay.com/docs/api/authentication/): merchant API keys and test/live modes.
- [Fetch all payments](https://razorpay.com/docs/api/payments/fetch-all-payments/): the read-only credential probe and bounded count.
- [Razorpay OAuth integration steps](https://razorpay.com/docs/partners/technology-partners/onboard-businesses/integrate-oauth/integration-steps/?preferred-country=IN): authorization-code exchange, explicit mode, merchant account ID, bearer access, expiry and rotating refresh tokens.
- [OAuth authorization-revoked webhook](https://razorpay.com/docs/webhooks/partners/oauth): event identity, raw-body verification and old-secret retries.
- [Webhook validation](https://razorpay.com/docs/webhooks/validate-test/): signatures, duplicate delivery and event ordering.
- [Razorpay documented authentication error](https://razorpay.com/docs/api/orders/create/): authentication failure can use HTTP 400, which is sanitized and classified alongside 401/403.
