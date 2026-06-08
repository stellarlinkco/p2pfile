# AGENTS.md

## Purpose

Project memory and operating contract for the P2P File v1 implementation. This repository is a Bun-based lightweight monorepo for a browser-first direct-transfer product.

## Source of truth

- Domain language: `CONTEXT.md`
- First-version runtime/product rules: `docs/mvp-product-rules.md`
- Feature scope and acceptance: `docs/feature-spec/p2p-file-first-version-feature-spec.md`

## Project identity

- Product promise: users should be able to transfer files in the browser without uploading them to cloud storage first.
- Primary path: `Direct Transfer`
- Fallback path: `Relayed Transfer`
- Share entry model: `Share Link` primary, `Access Code` and `QR Code` as alternate presentations of the same session entry.

## Repository layout

- `apps/web` — React/Vite frontend for sender and receiver surfaces.
- `apps/signal` — Hono-on-Bun signaling service and WebSocket entry path.
- `packages/shared` — Zod schemas, shared message types, and cross-app constants.
- `tests/e2e` — Playwright browser smoke/e2e tests.
- `scripts` — small repo automation scripts consumed by commands and hooks.

## Chosen stack

### Frontend
- Runtime/build toolchain: **Bun 1.x**
- UI: **React 19**
- Language: **TypeScript**
- Build/dev server: **Vite**
- Routing: **React Router v7**
- Styling: **Tailwind CSS 4**

### Backend/signaling
- Runtime: **Bun 1.x**
- HTTP/WebSocket framework: **Hono on Bun**
- Session state store: **Redis**
- Transport boundary: **WebRTC DataChannel** in browser, STUN/TURN for connectivity

### Shared/tooling
- Schema validation: **Zod 4**
- Lint/format: **Biome**
- Unit/integration tests: **bun test**
- Browser E2E: **Playwright**

## Canonical commands

Use the root `justfile` as the primary command surface.

- `just setup` — install workspace dependencies, activate hooks when git exists, install Playwright Chromium
- `just dev` — run `apps/signal` and `apps/web` together
- `just lint` — naming guard + structure guards + Biome
- `just format` — Biome write mode
- `just typecheck` — workspace TypeScript validation
- `just test-unit` — Bun unit/integration tests
- `just test-e2e` — Playwright browser smoke/e2e tests
- `just test` — all tests
- `just build` — workspace builds
- `just check` — lint + typecheck + test + build

Package-level scripts remain available for local iteration, but repo-level automation should route through `just`.

## Validation contract

Before reporting non-trivial implementation complete, run the most specific relevant command and then `just check` when the changed surface is broad enough to justify it.

Expected baseline:
- schema/state changes → `just test-unit`
- UI/routing changes → `just test-e2e`
- cross-workspace or release-boundary changes → `just check`

## Architecture boundaries

- `packages/shared` must stay runtime-light: schemas, types, constants, and protocol helpers only.
- `packages/shared` must not depend on Hono, React, or Redis clients.
- `apps/web` may depend on `packages/shared`, but must not depend on `apps/signal` or Redis directly.
- `apps/signal` may depend on `packages/shared`, but must not depend on `apps/web`.
- Do not introduce upload-to-cloud fallback; file contents stay on the peer path except relay transport.
- Preserve glossary terms from `CONTEXT.md`; do not invent parallel vocabulary for the same concepts.

## Long-term guardrails

- Source file length is mechanically limited by `constraints.yaml` and `scripts/check-file-length.ts`.
- Test file length is mechanically limited separately with a wider cap.
- Dependency direction is mechanically enforced by `scripts/check-dependency-boundaries.ts`.
- Forbidden filename drift is mechanically enforced by `scripts/check-naming.ts`.
- Pre-commit is medium strength: lint-stage checks must pass before local commit.
- Pre-push is medium strength: typecheck + unit tests + build must pass before local push.
- Browser E2E is CI-enforced and explicit-command-enforced, not pre-push-enforced.

## Review policy

Gray-box by default. White-box review required for:
- signaling/session claim logic
- receiver-token ownership
- relay/direct disclosure
- bearer-link entry behavior
- security-sensitive metadata exposure
- irreversible session-ending behavior

## Agent rules

- Prefer Bun-native workflows and APIs over Node-only assumptions.
- Do not introduce Node-only tooling when Bun-native or Bun-compatible tooling is sufficient.
- Treat `Share Link` as a bearer credential in code, UI, metadata, and tests.
- Keep the signaling service lightweight: session coordination, claim handling, signal exchange, short-lived session state.
- If a rule is claimed as enforced, it must point to a real config, hook, CI step, or command in this repo.
- Do not evade size or boundary guards by moving logic into vague utility buckets; preserve meaningful module boundaries.

## Enforcement index

- `justfile` — canonical repo command surface
- `package.json` — workspace scripts and root check pipeline
- `biome.json` — lint/format enforcement
- `tsconfig.base.json` + workspace `tsconfig.json` — TypeScript rules
- `constraints.yaml` + `scripts/read-constraints.ts` — machine-readable structural thresholds and boundaries
- `scripts/check-naming.ts` — forbidden filename drift guard
- `scripts/check-file-length.ts` — source/test length guard
- `scripts/check-dependency-boundaries.ts` — monorepo dependency-direction guard
- `bunfig.toml` + `tests/setup.ts` — Bun test baseline
- `playwright.config.ts` + `tests/e2e/*` — browser smoke/e2e baseline
- `.github/workflows/ci.yml` — CI execution of quality and E2E stages
- `.githooks/pre-commit` and `.githooks/pre-push` — conditional local git hooks after `git init` and `bun run prepare`/`just setup`

## Official documentation

### Bun
- Docs index: https://bun.com/docs
- TypeScript: https://bun.com/docs/typescript
- Workspaces: https://bun.com/docs/pm/workspaces
- HTTP server: https://bun.com/docs/runtime/http/server
- WebSockets: https://bun.com/docs/runtime/http/websockets
- Test runner: https://bun.com/docs/test

### Frontend
- React: https://react.dev/learn
- Vite: https://vite.dev/guide/
- React Router: https://reactrouter.com/home
- Tailwind with Vite: https://tailwindcss.com/docs/installation/using-vite

### Backend and validation
- Hono home: https://hono.dev/
- Hono on Bun: https://hono.dev/docs/getting-started/bun
- Hono WebSocket helper: https://hono.dev/docs/helpers/websocket
- Zod: https://zod.dev/
- Redis: https://redis.io/docs/latest/

### Browser transport
- MDN WebRTC API: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
- MDN RTCPeerConnection: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection
- MDN RTCDataChannel: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel

### Testing
- Playwright: https://playwright.dev/docs/intro

## Current readiness gaps

- Redis-backed live session state is scaffolded by contract only; implementation still pending.
- Real WebRTC signaling/session protocol is not implemented yet.
- Playwright currently proves browser shell readiness, not full sender/receiver transfer behavior.
- Hook files exist now but remain inactive until this directory is initialized as a git repo and hooks are activated.
- Line-length limits are intentionally gentle for v1 bootstrap and may need tightening once implementation stabilizes.
