# backend

Stable CommonJS Express backend with modular runtime architecture.

## File Tree

```text
backend/
├─ app.js
├─ index.js
├─ worker.js
├─ package.json
├─ jsconfig.json
└─ src/
   ├─ core/
   │  ├─ config/
   │  ├─ constants/
   │  ├─ errors/
   │  ├─ logger/
   │  ├─ middleware/
   │  ├─ models/
   │  ├─ routes/
   │  │  └─ registerRoutes.js
   │  ├─ security/
   │  └─ utils/
   ├─ infra/
   │  ├─ database/
   │  ├─ queues/
   │  ├─ redis/
   │  ├─ websocket/
   │  └─ workers/
   ├─ modules/
   │  ├─ admin/controllers/
   │  ├─ analytics/controllers/
   │  ├─ auth/
   │  ├─ automation/controllers/
   │  ├─ billing/
   │  ├─ campaigns/
   │  ├─ contacts/
   │  ├─ conversations/controllers/
   │  ├─ credentials/controllers/
   │  ├─ integrations/controllers/
   │  ├─ links/controllers/
   │  ├─ messages/controllers/
   │  ├─ meta/controllers/
   │  ├─ notifications/
   │  ├─ public/controllers/
   │  ├─ reports/controllers/
   │  ├─ templates/
   │  ├─ users/
   │  ├─ wallet/
   │  ├─ webhooks/controllers/
   │  ├─ workspaces/
   │  └─ ...
   ├─ shared/
   │  ├─ logger/
   │  ├─ services/
   │  └─ utils/
   └─ types/
```

## Backend Architecture

- Entrypoints
  - `app.js`: builds express app and middleware stack.
  - `index.js`: connects DB, creates HTTP server, mounts websocket, installs lifecycle handlers.
  - `worker.js`: connects DB, starts workers, installs lifecycle handlers.

- Route registration
  - Centralized in `src/core/routes/registerRoutes.js`.
  - Same route surface mounted at both:
    - `/`
    - `/api`

- Layers
  - `src/core/*`: platform concerns (config, middleware, route wiring, process lifecycle, logger).
  - `src/infra/*`: infrastructure concerns (mongo models, redis, queues, workers, websocket).
  - `src/modules/*`: business domains (controllers/services/repositories/validations).
  - `src/shared/*`: cross-module shared services and utilities.

- Queue and worker flow
  - Queue factory and single redis connection path in `src/infra/queues/*` and `src/infra/redis/*`.
  - Worker orchestrator in `src/infra/workers/index.js`.
  - Graceful shutdown closes workers, queue resources, and redis connection.

- Import policy
  - Cross-domain imports use aliases only:
    - `@core/*`
    - `@infra/*`
    - `@modules/*`
    - `@shared/*`
  - Relative imports only for local subtree paths.

- Compatibility cleanup status
  - Removed wrapper controllers:
    - `src/modules/authController.js`
    - `src/modules/templateMediaController.js`
    - `src/modules/workspaceController.js`
    - `src/modules/walletController.js`
  - Route imports updated to direct modular controller paths where those wrappers were used.

## Runtime checks

```bash
node -e "require('./app'); console.log('APP_OK')"
node -e "require('./worker'); setTimeout(() => process.exit(0), 3000)"
```
