# P2P File

Browser-first file transfer for sending files directly between two browsers. P2P File creates a short-lived session with a Share Link, Access Code, and QR Code that all point to the same transfer window. File contents stay on the peer path by default and only use relay transport when connectivity requires it.

## Screenshots

### Sender console

![Sender console screenshot](docs/screenshots/sender-console.png)

### Receiver preview

![Receiver preview screenshot](docs/screenshots/receiver-preview.png)

## What it does

- Sender selects one or more files and creates a Temporary Session Window.
- Receiver opens the Share Link, Access Code, or QR Code and sees a metadata-only Frozen Manifest before claiming.
- One receiver can claim a session at a time; later visitors see an occupied or completed notice.
- Transfers prefer Direct Transfer over WebRTC DataChannel and disclose Relayed Transfer when fallback is used.
- Multi-file transfers are serial. Completed files can be retained on receiver retry; unfinished files restart at file boundaries.
- Completed sessions enter a short-lived read-only Completed Session View for the sender and original receiver.

## Scope boundaries

This v1 intentionally does not provide folder transfer, partial receive, sender reattach after refresh, PWA/desktop/CLI surfaces, durable transfer history, upload-to-cloud fallback, or an extra application-layer passphrase.

## Repository layout

```text
apps/web        React 19 + Vite sender/receiver app built into Cloudflare Static Assets
apps/edge       Cloudflare Worker API, WebSocket relay, Durable Objects, and SPA fallback
apps/signal     legacy Bun signaling service kept for non-Worker experiments
packages/shared Zod schemas, protocol types, shared constants
tests/e2e       Playwright browser E2E coverage
scripts         repo guard scripts for naming, size, dependency boundaries, and cutover checks
```

## Stack

- Runtime/package manager/test runner: Bun 1.x
- Frontend: React 19, TypeScript, Vite, React Router v7, Tailwind CSS 4
- Runtime: Cloudflare Workers with Static Assets and Durable Objects
- Local tooling: Bun 1.x, Wrangler, Playwright, Biome
- Transfer: WebRTC DataChannel with STUN/TURN configuration and WebSocket relay fallback
- Validation: Zod, Bun test, Playwright, Biome

## Getting started

```bash
just setup
just dev
```

Local Cloudflare parity service:

- Worker app, API, WebSocket signaling, and SPA fallback: `http://127.0.0.1:8788`
- Status endpoint: `http://127.0.0.1:8788/api/status`
If `just` is not installed, use the equivalent Bun scripts from `package.json`.

## Configuration

Build-time variables:

```bash
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=example-user
VITE_TURN_CREDENTIAL=example-password
```

The browser client uses same-origin `/api/*` and `/ws/*` by default, so the Cloudflare route does not need a separate signal origin.
Wrangler reads the Worker entrypoint, Static Assets binding, Durable Object bindings, and Durable Object migrations from `wrangler.toml`.

## Cloudflare deployment

`wrangler.toml` is the approved deployment contract:

- Worker entrypoint: `apps/edge/src/index.ts`
- Static Assets: `./apps/web/dist` bound as `ASSETS`
- SPA fallback: `not_found_handling = "single-page-application"` for `/`, `/receive`, and `/f/:sessionId`
- Worker API routes: `/api/*`
- Worker WebSocket routes: `/ws/*`
- Durable Objects: `SESSION_OBJECT` (`SessionDurableObject`) and `SESSION_DIRECTORY` (`SessionDirectory`) with SQLite migrations

Use the Cloudflare command surface:

```bash
bun run dev:cloudflare     # builds apps/web/dist, then starts wrangler dev
bun run deploy:cloudflare  # builds apps/web/dist, then runs wrangler deploy
```

The Cloudflare route is a single Worker deployment. It does not need the legacy signal service, a reverse proxy, or an external live-session store for the approved path.
TURN credentials are still optional for restrictive NAT/firewall environments; transfer contents remain browser-to-browser or in-flight relay frames only.


## Cost and plan

- The current Cloudflare deployment uses SQLite-backed Durable Objects, so it can run on the Workers Free plan.
- Free-plan limits are enforced as hard caps. If you exceed them, the affected operation fails instead of silently billing overage.
- Workers Paid starts at $5/month. Cloudflare budget alerts notify on spend thresholds but do not stop usage.
- If you want a hard stop at your own quota, add an application-level gate before creating new sessions or accepting new sockets.

## Validation commands

Use the root `justfile` as the canonical command surface:

```bash
just dev-cloudflare     # builds apps/web/dist, then starts wrangler dev on the Worker path
just deploy-cloudflare  # builds apps/web/dist, then runs wrangler deploy
just lint               # naming, file length, dependency boundaries, Biome
just typecheck          # shared, signal, web, and edge TypeScript validation
just test-unit          # Bun unit/integration tests, including Cloudflare cutover validation
just test-e2e           # Playwright browser E2E tests
just build              # workspace builds
just check              # lint + typecheck + tests + build
```

Current E2E coverage includes Share Link entry, Access Code entry, QR Code entry, direct transfer, relay fallback disclosure, retry-budget exhaustion, interrupted receiver resume, occupied sessions, sender-ended sessions, storage failure handling, and mobile no-horizontal-overflow checks.

## Security and privacy notes

- Share Links are bearer credentials.
- Share surfaces are marked non-indexable and previews stay generic.
- Frozen Manifest exposes metadata only before claim; no file thumbnails or content preview are shown.
- The Worker coordinates sessions and signals; file contents are not uploaded to application storage.

## Documentation

- Domain language and invariants: [`CONTEXT.md`](CONTEXT.md)
- Runtime/product rules: [`docs/mvp-product-rules.md`](docs/mvp-product-rules.md)
- Feature scope and acceptance criteria: [`docs/feature-spec/p2p-file-first-version-feature-spec.md`](docs/feature-spec/p2p-file-first-version-feature-spec.md)
