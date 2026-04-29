# Waspakamify — UI Wireframe-Level Navigation (Solo vs Agency)

This doc is designed to be implemented directly on top of the current backend + existing frontend routes.

## Reality check (based on current backend)

- Multi-tenant isolation is **per logged-in userId** (not team/workspace based).
- No billing, roles beyond `user/admin`, no team members, no client workspaces in backend yet.
- “Agency mode” below is a **UI/UX packaging** that still maps to the same APIs; team/client features can be marked “Coming soon”.

---

## Global layout

### Shell

- **Left sidebar**: primary navigation (grouped sections + badges).
- **Top bar (main content header)**:
  - Page title + short helper text
  - Primary CTA (page-specific)
  - Secondary actions (filters, export, sync)
  - Global search (Inbox + Contacts)
- **Content**: card-based panels with empty states.
- **Footer (inside shell, bottom-right or settings page)**:
  - Docs link (Webhook setup, Meta setup)
  - Status indicator (API reachable + webhook connected)
  - Version/build info (optional)

### Universal UI elements

- **Onboarding checklist** (dismissible, persists):
  - Shows on Dashboard until all required steps complete.
- **Connectivity banner**:
  - “Credentials not connected / not validated” blocks sending + template submission.
- **Toasts**:
  - success/error, show `err.response.data.message` + optional `details`.
- **Empty states**:
  - Always include 1 primary action and 1 “Learn how” link.

---

## Sidebar IA (exact sections)

### Solo Marketer (simple, action-first)

**Section: Overview**
- Dashboard (`/app`)

**Section: Setup**
- Credentials (`/app/credentials`)
- Templates (`/app/templates`) — badge: count of `pending` templates

**Section: Campaigns**
- Broadcasts (`/app/send`)
- Tracked Links (`/app/links`)

**Section: Audience**
- Contacts (`/app/contacts`)
- Inbox (`/app/conversations`) — badge: total unreadCount

**Section: Automate**
- Automation (`/app/automation`)

**Bottom**
- Settings (`/app/settings`)
- Logout

### Agency/Team (ops-first, scale workflows)

Same routes, but different naming + grouping:

**Section: Operations**
- Dashboard (rename: “Ops Overview”) (`/app`)
- Inbox (`/app/conversations`)
- Contacts (`/app/contacts`)

**Section: Messaging**
- Templates (`/app/templates`)
- Broadcasts (`/app/send`)
- Tracked Links (`/app/links`)

**Section: Integrations**
- Credentials (`/app/credentials`)
- Automation (`/app/automation`)

**Bottom**
- Settings (`/app/settings`)
- “Workspaces (Coming soon)” (disabled item, tooltip: per-user only today)

---

## Sitemap (screens + sub-screens)

Public
- Login (`/login`)
- Register (`/register`)

App (auth required)
- Dashboard (`/app`)
  - “Quick actions” panel
  - “Recent sends” mini table
  - “Template health” panel (approved/pending/rejected)
- Credentials (`/app/credentials`)
  - Connect / Validate view
  - Current connection view (masked)
- Templates (`/app/templates`)
  - List + filters + status chips
  - Create/Edit drawer (local)
  - Template detail panel (right side)
  - Approvals actions (submit/status sync)
  - Meta sync modal
- Broadcasts (`/app/send`)
  - Single send tab
  - Bulk send tab (CSV paste/upload UX)
  - Logs panel (filters)
- Contacts (`/app/contacts`)
  - List + tags + quick edit
  - Create/Edit drawer
- Inbox (`/app/conversations`)
  - Conversation list + search
  - Unread filter
- Conversation detail (`/app/conversations/:phone`)
  - Contact summary panel
  - Message timeline
  - Mark read
  - (Optional) “Send template to this contact” quick action (uses `/messages/send`)
- Tracked Links (`/app/links`)
  - Create link form
  - “My links” (optional future; backend currently only logs clicks, not link objects)
- Automation (`/app/automation`)
  - API key panel + rotate CTA
  - Trigger test form (`/trigger-event`)
  - cURL snippets + webhook notes
- Settings (`/app/settings`)
  - Profile (`/auth/me`)
  - API Key rotate (`/auth/api-key/rotate`)

---

## Onboarding checklist (data-driven)

Show this on Dashboard as a vertical checklist with progress (0–5).

1) **Create account** (done once you have token)
2) **Connect WhatsApp credentials**
   - API: `GET /credentials/whatsapp`
   - Done when credentials exist AND `isValid === true`
3) **Sync templates from Meta** (recommended)
   - API: `POST /templates/sync-meta`
   - Done when templates count > 0
4) **Submit at least one template for approval** (if creating locally)
   - API: `POST /templates/:id/submit`
   - Done when any template `status in (pending|approved|rejected)`
5) **Send your first message**
   - API: `POST /messages/send`
   - Done when outbound message count > 0 (UI can infer from `GET /messages/logs?limit=1`)

Optional (nice-to-have)
- Add first contact (`POST /contacts`)
- Create first tracked link (`POST /links`)
- Trigger first automation (`POST /trigger-event`)

---

## Empty states (exact copy + CTA per page)

### Dashboard
- If no credentials: “Connect WhatsApp Cloud API to start sending.”
  - CTA: “Connect credentials” → `/app/credentials`
- If no templates: “Import templates from Meta or create one locally.”
  - CTA: “Sync from Meta” (modal) or “Create template”

### Credentials
- Empty: “Add your access token + phone number ID. We’ll validate it before saving.”
  - CTA: “Validate & Save”
- Invalid: show validation step that failed + “Fix values” helper text.

### Templates
- Empty: “No templates yet.”
  - CTA1: “Sync from Meta”
  - CTA2: “Create template”
- Pending-only: “Templates pending approval.”
  - CTA: “Sync status”
- Rejected: show `rejectedReason` with retry guidance.

### Broadcasts
- If no approved templates: “You need an approved template to send.”
  - CTA: “Go to Templates”
- Bulk: if no recipients: “Paste numbers or upload CSV.”
  - CTA: “Download CSV sample” (client-side only)

### Inbox
- Empty: “No inbound messages yet.”
  - CTA: “Verify webhook setup” (link to docs section inside Automation)

### Contacts
- Empty: “Build your audience list.”
  - CTA: “Add contact”

### Tracked Links
- Empty: “Create a tracked link to measure clicks.”
  - CTA: “Create link”

### Automation
- Empty: always show “API Key” panel + “Trigger test” form.
  - CTA: “Copy cURL”

---

## “Blocking rules” (prevent user confusion)

- If `GET /credentials/whatsapp` fails or returns `isValid:false`:
  - Disable: Template submit, Send, Bulk, Automation trigger test (optional)
  - Show banner: “Credentials not validated. Fix in Credentials.”
- If template `status !== approved`:
  - Disable sending (already enforced by backend); show inline message in UI.

---

## Recommended page CTAs (per route)

- `/app`: Primary “Send broadcast”; secondary “Sync templates”
- `/app/credentials`: Primary “Validate & Save”
- `/app/templates`: Primary “Create template”; secondary “Sync from Meta”
- `/app/send`: Primary “Send now” / “Start bulk send”
- `/app/contacts`: Primary “Add contact”
- `/app/conversations`: Primary “Search”; secondary “Unread only”
- `/app/links`: Primary “Generate tracked link”
- `/app/automation`: Primary “Trigger test”; secondary “Rotate API key”
- `/app/settings`: Primary “Rotate API key”

