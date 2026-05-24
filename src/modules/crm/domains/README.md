# CRM Backend Domain Plan

This is a non-breaking domain scaffold for incremental CRM expansion.
Current runtime files remain in existing `controllers/`, `services/`, `repositories/`, `middleware/`, `routes/`.

Planned domain split:
- `admin-control/`: super/admin CRM controls (workspace toggles, employee lifecycle).
- `owner-control/`: workspace-owner CRM controls.
- `employees/`: employee auth/profile/status flows.
- `leads/`: lead detection/distribution/assignment.
- `conversations/`: CRM conversation access and read models.
- `messaging/`: outbound/inbound message domain logic.
- `realtime/`: socket/SSE CRM event streams.
- `settings/`: CRM config by workspace.
- `analytics/`: CRM metrics and summaries.
- `audit/`: assignment audits and security actions.

Rule: move files only in dedicated migration batches with route and worker verification.
