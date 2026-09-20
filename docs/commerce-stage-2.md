# Merchant-owned Commerce: Stage 2

Updated: 2026-09-10. Backend implementation is complete locally. This increment implements product/catalog APIs and background Meta synchronization. Dashboard and inbox presentation remain Stage 6; gateway connections remain Stage 3.

## Behavior

Authenticated workspace members can discover catalogs already linked to their active WABA, bind a dedicated catalog, manage local products, upload product images, and read/update the phone's catalog/cart settings.

The first binding requires an empty physical-products catalog linked in Commerce Manager. Reconnecting the same historical binding preserves its products and IDs. Existing populated third-party catalogs are not imported or overwritten. Disconnect is local: it stops synchronization and preserves history; it does not unlink or delete Meta assets.

Product saves return immediately after a local database write. A recurring job on the existing BullMQ webhook queue synchronizes up to 20 products from one catalog per run. The job is scheduled every 15 seconds when enabled. Pending database records are the durable work source, so a lost enqueue after a save does not lose synchronization work.

Money remains integer paise internally. Requests use decimal price strings and require explicit tax confirmation (a null rate means unknown) and product condition. Stock cannot fall below reservations, and tracking cannot be disabled while reservations exist. Category is a local organizational label, not an inferred Meta taxonomy.

Archive marks the local product unavailable immediately and queues a remote out-of-stock/staging update. This does not promise instant disappearance from WhatsApp while Meta sync is pending.

## Access and safeguards

- Every route uses existing authentication, workspace membership and Commerce permissions.
- Product reads/writes include workspace and active catalog scope. Invalid IDs and unknown writable fields are rejected.
- Updates require the last observed revision. Conditional database writes also check the reservation count and submission revision.
- Catalog mutations and workers use expiring ownership leases. Product submissions persist their revision before network I/O.
- SKU lookup and managed-product markers prevent adopting or overwriting unrelated Meta products. CREATE explicitly disables upsert.
- After ambiguous writes, workers inspect the submitted revision before sending another write. Newer local edits remain pending until the earlier submission resolves.
- Per-product Meta batch failures are handled separately. Backoff honors numeric Retry-After and stops after eight attempts.
- Submission acceptance, verified revision, review status and visibility are distinct fields. Pending review is polled; rejection is surfaced.
- Provider errors are sanitized. Tokens remain in authorization headers; remote pagination URLs are not followed.
- Existing media validation, storage and workspace quota services handle JPEG/PNG uploads up to 5 MiB.
- Local permissions are additive to Stage 1. Existing platform billing and Razorpay payment behavior are unchanged.

A synced revision establishes that the managed revision marker was read back and the reported review status was approved. Actual WhatsApp visibility also depends on Meta review/propagation, catalog settings, item availability and the connected assets. Native payment eligibility is not established by catalog sync.

## API contract

All paths below are relative to `/api/commerce` (the existing root-mounted `/commerce` alias also applies). Authentication and `x-workspace-id` are required.

| Method/path | Permission | Input |
| --- | --- | --- |
| GET /catalogs | commerce.catalog.view | Optional cursor |
| GET /catalog | commerce.catalog.view | Current local binding |
| PUT /catalog | commerce.catalog.manage | catalogId, confirmDedicatedCatalog: true |
| PATCH /catalog/settings | commerce.catalog.manage | revision, catalogVisible, cartEnabled |
| POST /catalog/refresh | commerce.catalog.manage | revision |
| DELETE /catalog | commerce.catalog.manage | revision; local disconnect |
| GET /products | commerce.products.view | limit 1–100, cursor, archived boolean |
| GET /products/:productId | commerce.products.view | Product identifier |
| POST /products | commerce.products.manage | Product fields below |
| PATCH /products/:productId | commerce.products.manage | revision and changed fields |
| POST /products/:productId/archive | commerce.products.manage | revision |
| POST /products/:productId/sync | commerce.products.manage | revision; retry/status inspection |
| POST /images | commerce.products.manage | multipart file |

Example create body:

```json
{
  "sku": "TEA-REGULAR",
  "name": "Regular Tea",
  "description": "Regular tea, one serving",
  "condition": "new",
  "brand": "Merchant's brand",
  "imageUrl": "https://merchant.example/images/tea.jpg",
  "productUrl": "https://merchant.example/products/tea",
  "price": "20.00",
  "taxRateBps": null,
  "taxConfirmed": true,
  "available": true,
  "trackInventory": false,
  "stockOnHand": 0
}
```

The service does not infer a merchant's tax rate, brand or condition. SKU and catalog identity are immutable. Query validation uses the returned Joi value directly and does not assign to Express 5's query getter.

## Deployment preparation

The feature defaults off. No environment, database or live Meta changes were made during implementation.

1. Select an isolated staging database with the existing operator variables `COMMERCE_MONGODB_URI` and `COMMERCE_MONGODB_DB`.
2. Review `npm run commerce:indexes`. The complete manifest now contains 12 collections and 31 indexes (two added product query indexes).
3. Apply and check indexes using the Stage 1 operator script. Neither command was run against a database in this session.
4. Set `COMMERCE_CATALOG_ENABLED=true` for both API and worker in staging and restart them. Both API and job handler verify required catalog/product indexes; readiness does not create or modify indexes.
5. Use a ready WhatsApp connection with catalog-management access and a dedicated linked catalog. Existing per-connection Graph version is preserved.
6. Verify upload, create, edit, archive, review polling, revocation, connection replacement and restart recovery with real staging assets before production activation.

The global flag enables the catalog module only. It does not enable checkout or alter `CommerceSettings.liveCheckoutEnabled`.

## Verification and limits

- 55 tests pass, including HTTP authentication/membership/permissions, request validation, tenant-scoped service calls, update conflicts, pagination, unknown-write recovery, concurrent-edit simulation, pending/rejected review, archive behavior and Stage 1 regression tests.
- Final suite command: `node --test --experimental-test-isolation=none src/modules/commerce/tests/*.test.cjs` on Node 22.14.
- All 44 applicable JavaScript/CommonJS files passed syntax checks. Index dry-run and diff whitespace checks passed.
- The existing backend build command passed; it is a no-op. No backend typecheck or executable lint setup exists. Frontend was not changed or rebuilt.
- An outside-sandbox test invocation was rejected by automatic approval review because of the usage limit. All final tests subsequently ran inside the available sandbox without child test processes, including the localhost HTTP test.
- Database and Meta adapters are simulated in the tests. No MongoDB replica-set concurrency test, Redis scheduler integration, live Meta request, production deployment or image-storage upload was performed.
- An unknown submission can require operator investigation after retries exhaust. The retry API continues verification; it does not assume an absent lookup proves a CREATE was never accepted.
- Meta does not accept a database lease as a fencing token. Time-limited requests and durable unresolved submissions prevent blind resubmission, but live restart/network failure tests remain a rollout requirement.
- The stage introduces additional schema fields and indexes only; no migration or index application occurred.
- The user's existing LandingNavbar frontend edit was left intact.

GO for Stage 3 implementation. NO-GO for production catalog activation until staging infrastructure and asset verification pass.

## Files changed in Stage 2

- `src/infra/database/CommerceProduct.js`, `CommerceCatalogConnection.js`
- `src/modules/commerce/domain/catalog.js`
- `src/modules/commerce/validators/catalog.validators.js`
- `src/modules/commerce/repositories/catalog.repository.js`
- `src/modules/commerce/services/catalog.service.js`, `catalogReadiness.service.js`, `metaCatalog.service.js`, `catalogSync.service.js`
- `src/modules/commerce/controllers/catalog.controller.js`, `routes/catalog.routes.js`
- `src/modules/commerce/tests/catalog-validation.test.cjs`, `meta-catalog.test.cjs`, `catalog-service.test.cjs`, `catalog-sync.test.cjs`, `catalog-routes.test.cjs`
- `src/core/routes/registerRoutes.js`, `src/infra/workers/webhook.worker.js`
- Stage 1 progress note and this document

## Official contracts reviewed

- [Meta ProductCatalog SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/productcatalog.py): catalog fields, product reads, product creation and explicit upsert control.
- [Meta ProductItem SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/productitem.py): retailer IDs, custom labels, price/currency, condition, availability, visibility and review states.
- [Meta Graph batch SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/api.py): relative request URLs, form-encoded subrequest bodies and per-request responses.
- [Meta WhatsAppBusinessAccount SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/whatsappbusinessaccount.py): linked product-catalog edge.
- [Meta phone commerce settings](https://www.postman.com/meta/whatsapp-business-platform/request/30lrpw8/set-or-update-commerce-settings): catalog visibility and cart flags.

The direct Meta developer reference was unavailable to the documentation tool. Official SDK and Meta's official Postman collection were used; their contracts still require validation against the merchant's pinned Graph version and asset permissions.

