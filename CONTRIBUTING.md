# Contributing

## Non-breaking rule
UI/behavior must not change unless explicitly requested.

## Backend flow
`route -> validation -> controller -> service -> repository -> database`

## Frontend flow
`page -> hook -> service/api -> backend`

## File size guidelines
See `CODE_LIMITS.md`.

## PR checklist
- No UI/behavior changes unless requested
- `frontend npm run build` passes
- Backend starts cleanly (`npm start`)
- New code goes in feature module (no random utils)

