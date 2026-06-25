# E2E Transfer Stability Coverage Spec

- **Status**: Ready for implementation
- **Date**: 2026-06-25
- **Related docs**: `CONTEXT.md`, `docs/mvp-product-rules.md`, `docs/feature-spec/p2p-file-first-version-feature-spec.md`, `.agents/qa/config.yaml`
- **Purpose**: Close the known E2E gaps for weak-network and large-file transfer stability without claiming production validation before evidence exists.

## Converged Facts

**Goal:** Add executable E2E coverage for transfer stability gaps: real-ish network degradation, active Direct Transfer signaling reconnect, sender abrupt exit, TURN relay-only transfer, Redis-backed signaling, storage pressure, and browser matrix.

**Non-goals:** Do not add upload-to-cloud fallback, folder transfer, partial file selection, sender reattach after refresh, production/staging proof, real user files, or fake QA verdict artifacts.

**Users / actors:** Sender, Anonymous Receiver, later visitor/non-owner, maintainer running local QA.

**Constraints:** Preserve `Direct Transfer`, `Relayed Transfer`, `Share Link`, `Access Code`, `QR Code`, `Receiver Token`, `Frozen Manifest`, and `Completed Session` terminology. Treat Share Links and Receiver Tokens as bearer credentials. Evidence must be collected in caller-owned run directories, not `.agents/qa`.

**Known context:** Existing Playwright E2E already covers happy paths, direct/relay completion, receiver reload/retry, Worker same-origin flows, OPFS streaming, multi-file resume, claim conflict, completed non-owner notice, and sender-ended UI. QA command rails exist through `just qa-e2e-*`.

**Assumptions:** Chromium remains the first implementation target. New flows should extend `.agents/qa/config.yaml`, `.agents/qa/flows/*.md`, and existing Playwright suites unless a new spec file keeps a flow clearer. TURN and Redis flows may be marked blocked until local test configuration exists.

**Blocking questions:** None for a local implementation spec. TURN credentials and Redis service details are implementation-time blockers for those specific flows, not for this source-of-truth spec.

## Compact PRD

### Problem Statement

Current E2E coverage proves the main transfer paths and several deterministic recovery paths, but it does not prove that transfers remain stable across realistic weak-network behavior, active signaling reconnect during Direct Transfer, production-like state backends, browser differences, or storage-pressure failures. This leaves a gap between the product promise and the reliability evidence for large files and poor networks.

### Goals

- Add E2E flows that make transfer reliability observable under weak network and large-file conditions.
- Prove that active Direct Transfer does not fail just because the signaling WebSocket reconnects.
- Prove correct user-visible outcomes for abrupt sender lifecycle events.
- Establish blocked-but-explicit rails for TURN relay-only and Redis-backed production-like validation.
- Extend QA map/commands so maintainers can run stability-specific flows deliberately.

### Non-goals

- No production/staging validation without explicit approval.
- No real provider calls outside local/sandbox/replay configuration.
- No permanent evidence, `verdict.json`, or `REPORT.md` under `.agents/qa`.
- No new product behavior beyond E2E coverage unless a test exposes a real bug.
- No claim that file size is unlimited; coverage must preserve Environment-Dependent Size Limit language.

### Users / Actors

- Sender: creates a session and keeps source files readable while transfer runs.
- Anonymous Receiver: claims and receives the full Frozen Manifest.
- Later visitor: opens an occupied/completed/ended session without the original Receiver Token.
- Maintainer: runs local E2E flows and inspects evidence.

### User Stories

1. As a sender, I want a large Direct Transfer to survive a signaling reconnect, so that weak signaling transport does not interrupt an already-open peer transfer.
2. As a receiver, I want clear recovery or completion behavior under network degradation, so that I know whether to wait, retry, or ask the sender to recreate the session.
3. As a maintainer, I want targeted E2E flows for transfer stability, so that reliability regressions are caught before release.
4. As a maintainer, I want TURN and Redis gaps explicitly represented, so that production-like reliability is not silently assumed.

### Functional Requirements

- **FR-001:** Add an E2E scenario where sender signaling WebSocket closes during an active large Direct Transfer and the transfer remains alive or reaches an explicit recoverable state without false completion.
- **FR-002:** Add a network-degradation E2E scenario that applies bounded latency/bandwidth degradation to at least one large Direct Transfer and one Relayed Transfer path.
- **FR-003:** Add an E2E scenario where sender reloads or closes during active transfer and receiver reaches Sender-Ended Session guidance, not a hanging transfer or reusable completed page.
- **FR-004:** Add storage-pressure/failure E2E coverage for receiver large-file storage: OPFS unavailable, write failure, or quota-like failure must produce a clear failure/retry/recreate state.
- **FR-005:** Add QA map entries and command routing for each new stability flow.
- **FR-006:** Represent TURN relay-only validation as an executable flow that is blocked until local TURN sandbox variables are configured.
- **FR-007:** Represent Redis-backed signaling validation as an executable flow that is blocked until a local Redis service and cleanup policy are configured.
- **FR-008:** Extend browser-matrix coverage beyond Desktop Chromium where project-compatible APIs permit it; unsupported browsers must assert correct limitation/failure messaging rather than pretending parity.

### Acceptance Criteria

- **AC-001:** `just qa-e2e-check` passes after adding the new QA map entries and flow notes.
- **AC-002:** A maintainer can run a named signaling-reconnect stability flow through `QA_E2E_FLOW_ID=<id> QA_E2E_TARGET=<target> just qa-e2e-run`.
- **AC-003:** Active Direct Transfer signaling reconnect flow captures evidence that the DataChannel path either completes or remains recoverable; it must not silently close due only to signaling WebSocket reconnection.
- **AC-004:** Network-degradation flow captures DOM status, transfer mode, console/network evidence, and final completed/recoverable/ended state.
- **AC-005:** Sender abrupt exit flow proves receiver sees Sender-Ended Session guidance and cannot continue downloading from a dead sender.
- **AC-006:** Storage failure flow proves large-file receiver storage errors do not yield false Completed Session.
- **AC-007:** TURN and Redis flows are either runnable locally with documented env/service setup or explicitly blocked in QA map/flow notes with missing prerequisites.
- **AC-008:** No new flow stores run evidence under `.agents/qa`.

### Edge Cases / Failure Handling

- Signaling WebSocket closes while Direct Transfer DataChannel is open.
- Sender closes/reloads before file-end or complete message.
- Receiver reloads after partial large-file progress.
- Relay fallback is active while WebSocket relay messages are delayed.
- OPFS is unavailable or write operations fail.
- Browser lacks required APIs for a large-file path.
- TURN or Redis prerequisites are absent.

### Constraints

- File contents must remain on peer/relay transport paths; no cloud upload fallback.
- Completion remains Integrity-Gated Completion over the entire File Manifest.
- Tests must assert user-visible mode disclosure: Direct Transfer vs Relayed Transfer.
- Evidence directories are caller-owned and outside `.agents/qa`.

### Out of Scope

- Production monitoring, chaos infrastructure, paid TURN provider setup, Redis deployment, and provider credential management.
- Mobile app automation; only browser E2E is in scope.
- Performance benchmarking beyond functional stability evidence.

## Execution Spec

### Goal

Install and implement targeted E2E coverage that turns the known transfer-stability gaps into runnable local flows, while explicitly blocking production-like flows whose prerequisites are not yet repo-proven.

### Scope

#### In scope

- Playwright tests for new local stability scenarios.
- QA map and flow-note updates under `.agents/qa/`.
- `scripts/qa-e2e.ts` flow routing updates.
- Minimal test helpers for controlled signaling close, network degradation, sender page lifecycle, and storage failure.
- Documentation of blocked TURN/Redis/browser prerequisites.

#### Out of scope

- Shipping TURN or Redis infrastructure.
- Changing production behavior unless a new E2E test exposes a real defect.
- CI workflow changes unless maintainers explicitly request trigger-only CI updates.

### Relevant Context

- `playwright.config.ts` runs local `@p2pfile/signal` and `@p2pfile/web` on `127.0.0.1:3001` and `127.0.0.1:4173`.
- `tests/e2e/worker.playwright.config.ts` runs local Worker edge on `127.0.0.1:8788`.
- Existing QA flows: `local-session-entry-transfer`, `worker-share-link-edge`, `large-transfer-reliability`.
- Existing known gaps: real weak-network emulation, active Direct Transfer signaling reconnect, TURN relay-only E2E, Redis-backed E2E, browser matrix, larger storage-pressure coverage, sender abrupt tab close/reload.

### Terms / Assumptions

- **Network degradation** means deterministic test-applied latency/bandwidth/offline behavior, not an uncontrolled flaky run.
- **Recoverable state** means visible retry/reconnect/recreate guidance that matches product rules.
- **Blocked flow** means a QA map entry and flow note exist, but the runner refuses to execute until required env/service prerequisites are present.

### Affected Surfaces

- **Code:** `tests/e2e/*`, `tests/e2e/*.support.ts`, `scripts/qa-e2e.ts`.
- **Data / schema:** No production schema changes expected. Test-only generated files and local browser storage state may change.
- **API / CLI / UI:** Existing local `just qa-e2e-*` commands; UI status/mode disclosure assertions.
- **Tests:** Playwright E2E only unless implementation exposes a lower-level bug requiring unit regression.
- **Docs / ops:** `.agents/qa/config.yaml`, `.agents/qa/flows/*.md`, this spec.

### Technical Direction

1. Add `direct-active-signal-reconnect-large-transfer` flow.
   - Reuse sender WebSocket control from Worker support, or move a generic helper into shared E2E support.
   - Use a large deterministic file and slow chunks.
   - Close sender signaling socket while receiver shows active progress.
   - Assert sender/receiver do not enter false ended/failed state solely from signaling reconnect and eventually reach completed or explicit recoverable state.

2. Add `network-degradation-stability` flow.
   - Prefer Playwright/Chromium CDP network emulation for latency and throughput.
   - Cover one Direct Transfer and one Relayed Transfer case.
   - Capture mode disclosure, status text, console errors, request/WebSocket observations, and final state.

3. Add `sender-abrupt-exit` flow.
   - Use sender reload and context/page close during active transfer.
   - Assert receiver sees Sender-Ended Session guidance and no completed session view/save buttons.

4. Add `storage-pressure-large-file` flow.
   - Inject OPFS unavailable/write failure/quota-like failure in receiver page before claim.
   - Assert no false completion; file states and notice guide retry/recreate.

5. Add blocked flow notes for `turn-relay-only-transfer` and `redis-backed-signal-e2e`.
   - QA runner should fail early with a prerequisite message if required env/service is absent.
   - Do not invent credentials or Redis lifecycle commands beyond repo-proven local setup.

6. Add browser-matrix extension only after capability check.
   - Add Firefox/WebKit projects only if existing flows can express expected unsupported paths.
   - Do not convert browser API limitations into false product failures.

### Validation Plan

- **VAL-001:** QA install remains valid. Surface: CLI. Evidence: `just qa-e2e-check` stdout.
- **VAL-002:** Active Direct Transfer survives sender signaling reconnect or reaches explicit recoverable state. Surface: browser. Evidence: Playwright stdout plus DOM trace/screenshot in caller-owned `EVIDENCE_DIR`.
- **VAL-003:** Network-degraded Direct Transfer and Relayed Transfer produce correct mode disclosure and terminal/recoverable state. Surface: browser. Evidence: Playwright stdout, network/console trace, DOM evidence.
- **VAL-004:** Sender reload/page close during active transfer produces Sender-Ended Session guidance for receiver. Surface: browser. Evidence: DOM assertions and screenshot/trace.
- **VAL-005:** Receiver storage failure does not create false Completed Session. Surface: browser storage + UI. Evidence: DOM assertions, error notice, file state trace.
- **VAL-006:** TURN flow blocks cleanly without local TURN env; runs only when env exists. Surface: CLI/browser. Evidence: blocked stdout or Playwright evidence.
- **VAL-007:** Redis flow blocks cleanly without local Redis service; runs only when service config exists. Surface: CLI/API/WebSocket. Evidence: blocked stdout or Playwright/API/WebSocket evidence.
- **VAL-008:** Browser matrix additions either pass supported flows or assert explicit unsupported-state behavior. Surface: browser. Evidence: per-browser Playwright output.

### Risks / Open Questions

- TURN sandbox URL/credentials are unknown.
- Redis local service startup and cleanup policy are unknown.
- WebKit/Firefox support may be constrained by WebRTC/OPFS/file-save API behavior.
- Network emulation may not affect WebRTC DataChannel exactly like real packet loss; record this as controlled evidence, not production proof.
- Very large-file E2E can be slow/flaky; start with bounded sizes and explicit environment-dependent language.

### Mission Handoff

Suggested milestones:

1. **QA map expansion**
   - Add new flow IDs and blocked prerequisites to `.agents/qa/config.yaml` and `.agents/qa/flows/`.
   - Update `scripts/qa-e2e.ts` routing.
   - Evidence: `just qa-e2e-check`.

2. **Active signaling reconnect coverage**
   - Add browser E2E for large Direct Transfer with sender signaling socket close mid-transfer.
   - Evidence: targeted `qa-e2e-run` output and DOM trace.

3. **Network degradation coverage**
   - Add controlled latency/bandwidth flow for direct and relay.
   - Evidence: targeted `qa-e2e-run` output and network/console/DOM evidence.

4. **Sender abrupt lifecycle coverage**
   - Add sender reload/page close during active transfer.
   - Evidence: receiver Sender-Ended Session assertions.

5. **Storage pressure coverage**
   - Add OPFS unavailable/write failure path.
   - Evidence: no false completion and clear failure/recovery UI.

6. **Blocked production-like rails**
   - Add TURN and Redis blocked flows with explicit prerequisites.
   - Evidence: blocked command output when prerequisites absent.

Required evidence:

- Exact command invocations.
- Playwright stdout.
- DOM/status/mode evidence.
- Screenshots/traces only in caller-owned evidence dirs.
- No `.agents/qa` run artifacts.

Human gates:

- Approve TURN sandbox credentials/source before enabling TURN flow.
- Approve Redis local service strategy before enabling Redis-backed flow.
- Decide whether browser matrix should be blocking or informational in CI.

## Readiness

Readiness: Ready

Reason: The spec names what to build, what not to build, the existing seams to use, blocked prerequisites, and validation evidence for each missing transfer-stability coverage area.

Next: Implement milestone 1 first, then the active Direct Transfer signaling reconnect E2E because it targets the most recent reliability bug mechanism.
