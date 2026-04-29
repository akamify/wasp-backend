## Waspakamify Backend (WhatsApp Marketing SaaS)

Node.js + Express + MongoDB backend for a multi-tenant WhatsApp Cloud API marketing platform.

### Quick start

1. Copy `.env.example` to `.env` and fill values
   - Generate `CREDENTIALS_ENCRYPTION_KEY` (32 bytes base64):
     - `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Start MongoDB
3. Run:

```bash
npm start
```

### Frontend (React + Tailwind)

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

### Core endpoints

- Auth
  - `POST /auth/register`
  - `POST /auth/login`
  - `GET /auth/me`
- WhatsApp credentials (per-tenant, encrypted at rest)
  - `PUT /credentials/whatsapp`
  - `GET /credentials/whatsapp`
  - `DELETE /credentials/whatsapp`
- Templates
  - `POST /templates`
  - `GET /templates`
  - `POST /templates/:id/submit`
  - `GET /templates/:id/status`
- Messaging
  - `POST /messages/send`
  - `POST /messages/bulk`
  - `GET /messages/logs`
  - `GET /messages/:phone`
- Webhooks (public)
  - `GET /webhooks/whatsapp` (Meta verification)
  - `POST /webhooks/whatsapp` (status updates + inbound messages)
- Analytics
  - `GET /analytics/overview`
  - `GET /analytics/template/:id`
- Click tracking
  - `POST /links` (returns a `trackedUrl`)
  - `GET /t/:code` (logs click + redirects)
- Automation
  - `POST /trigger-event` (JWT `Authorization: Bearer ...` OR `X-API-Key: ...`)
