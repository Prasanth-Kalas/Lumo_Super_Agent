# Contributing to Lumo

Lumo's audit trail is part of the product. Future security reviews, incident
response, and marketplace certifications all depend on commits that explain
what changed and why.

## Commit scope

Keep one product or platform concern per commit:

- UI-only work belongs in a UI commit.
- intelligence-layer milestones belong in their own commits.
- database migrations should ship with the code path that first uses them.
- docs should travel with the behavior they document.

Do not bundle broad UI redesigns with registry, routing, security, or
orchestrator changes. If a rollback is needed, the revert should not also
remove an unrelated platform capability.

CI runs `npm run lint:commits` on PRs and pushes to main. The check flags
commits that mix brand/global UI assets such as `public/*`, `BrandMark`, or
`app/globals.css` with runtime files such as `lib/*`, `app/api/*`, registry
config, middleware, or migrations. If a rare exception is intentional, split
the work first if possible; otherwise document the exception in the commit body.

## Commit messages

Use the title to name the behavior, not only the files touched:

- Good: `feat: wire archive recall into chat`
- Good: `fix: block high-risk auto-install without confirmation`
- Avoid: `update components`
- Avoid: `UI overhaul` when the diff also changes runtime behavior

When a commit lands a review checklist item, mention the checklist in the body.
That gives `git blame` enough context when someone investigates a production
issue months later.
