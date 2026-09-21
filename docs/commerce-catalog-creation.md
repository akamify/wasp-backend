# Create a catalog from AIWizChat

Ecommerce Management > Settings > WhatsApp catalog now offers **Create new catalog** alongside the existing catalog connection form. Enter a name, confirm ownership, then select **Create & connect**. Once connected, use the existing visibility/cart switches and Catalog & Products editor. Product publication still depends on the catalog sync worker and Meta acceptance.

## Prerequisites

- Deploy the backend and frontend together; keep `COMMERCE_CATALOG_ENABLED=true` and the existing Commerce indexes ready.
- The selected workspace must have a ready WhatsApp connection. The caller needs `commerce.catalog.manage`.
- Meta must authorize the token to read the WABA owner business, create a business-owned catalog, and link it to that WABA. Check business/catalog/WhatsApp management permissions and asset access for the app's supported Graph version. Enabling an environment flag does not grant Meta permissions. No new platform API key is required.
- Connected merchants can use WhatsApp Setup > **Authorize catalog access**. This runs Embedded Signup again for permission consent while preserving the active connection. The Facebook Login for Business configuration must select both **WhatsApp accounts** and **Catalogs** under Assets, plus `catalog_management`, `whatsapp_business_management` and `whatsapp_business_messaging` under Permissions. The backend accepts the new token only when all three scopes, the existing WABA and the existing phone match; a cancelled, rejected or mismatched flow leaves the old token active. AIWizChat does not request `business_management` merely to manage catalog products.
- Catalog setup has two permission-aware modes. An empty catalog created and linked in Meta Commerce Manager can be discovered, connected and synchronized with `catalog_management`. Creating a new business-owned catalog from AIWizChat additionally requires `business_management`; the setup API reports this capability and the create endpoint enforces it before any provider write. Until Meta grants it, the UI keeps the manual Meta catalog path available.
- The database account needs insert/update/read access to the new `commercecatalogsetups` collection. Its deterministic string `_id` is the uniqueness constraint; no custom index migration or changes to existing document schemas are needed. No live database is modified by deploying the source alone.

## API and safety

- `GET /commerce/catalog/setup`: status for the current workspace/WABA, including saved catalog ID; management permission required.
- `POST /commerce/catalog/create`: `{name, confirmOwnership: true, recoveryCatalogId?}`. The client cannot choose a business, workspace, or WABA ID. Business ownership is resolved from the authenticated workspace's active WABA.
- Meta calls: read `/{WABA_ID}?fields=id,owner_business_info`, create `/{BUSINESS_ID}/owned_product_catalogs` with `vertical=commerce`, link `/{WABA_ID}/product_catalogs` with `catalog_id`, then verify and reuse the existing local binding service.
- A durable setup record and a three-minute lease serialize concurrent creation. Creation intent is saved before calling Meta; the returned ID is saved before linking. Provider HTTP calls have bounded timeouts. A definite rejection allows retry; an ambiguous response or process crash does not issue another creation request.
- A failed link can be resumed with **Continue setup**, including after a page refresh or process restart. If creation outcome is unknown, first refresh status; recover using the catalog ID from Commerce Manager. Ownership is checked again. If no catalog can be found, an operator must investigate rather than blindly resetting the creation intent.
- A different existing remote catalog blocks linking. The application never intentionally unlinks/replaces it. Concurrent changes made directly in Meta cannot be locked by AIWizChat; avoid editing bindings there during setup.
- Setup is retained per workspace/WABA. After local disconnect, continuing setup reconnects the saved catalog rather than creating duplicates. Catalog replacement and destructive reset are outside this feature.
- An active phone/WABA change blocks continuation. No access tokens are returned or stored in setup records.

## Release verification

Automated tests cover provider request shapes, permissions/validation, existing bindings, concurrent requests, ambiguous writes, resume after linking failure, ownership and account changes, and rendered UI states. These are mocked provider/database tests, not live Meta or MongoDB integration tests.

Before enabling for customers, run one authorized staging merchant through create, link, refresh, product sync and WhatsApp visibility. Confirm the deployed Meta token/app has sufficient access. Test a denied-permission response and resume after a link failure. Do not claim production readiness solely from mocked tests.

Official SDK references:
- https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/business.py
- https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/whatsappbusinessaccount.py
