# Transfer Throughput and OPFS Performance Spec

- **Status**: Ready for implementation
- **Date**: 2026-07-14
- **Version**: throughput-opfs-v1
- **Related docs**: `CONTEXT.md`, `docs/mvp-product-rules.md`, `docs/feature-spec/p2p-file-first-version-feature-spec.md`, `docs/feature-spec/p2p-file-transfer-reliability-prd.md`, `docs/feature-spec/e2e-transfer-stability-coverage-spec.md`, `AGENTS.md`
- **Current code references**: `apps/web/src/lib/transfer/receiver-sinks.ts`, `receiver-protocol.ts`, `receiver-runtime.ts`, `transfer-scheduler.ts`, `sender-runtime-helpers.ts`, `relay-queue.ts`, `runtime-shared.ts`, `apps/web/src/routes/home-flow.ts`, `receive-flow-claim.ts`, `apps/web/src/lib/transfer/throughput-ceiling.test.ts`

## Converged Facts

**Goal:** Remove progressive large-file slowdown while preserving resumable, integrity-gated `Direct Transfer` and `Relayed Transfer`; then tune each transport through bounded controls and reproducible WAN evidence.

**Non-goals:** No cloud-storage upload fallback, no unbounded buffers, no claim of unlimited file size, no chunk-size increase in this mission, no weakening of digest/offset checks, no replacement of `Direct Transfer` with relay, and no production deployment as part of implementation.

**Users / actors:** Sender, Anonymous Receiver holding the current `Receiver Token`, maintainer running focused reliability/performance validation.

**Constraints:** Keep `MANIFEST_CHUNK_BYTES` at 64 KiB. Keep file contents on the peer path or relay forwarding path. `Completed Session` remains gated by the complete `Frozen Manifest` and integrity verification. Resume progress must never advance beyond locally durable receiver bytes. Direct and relay controls must have explicit hard memory bounds and must not share one fixed profile.

**Known context:** Large files over 1 MiB use `OpfsSink`. It closes the writable every two chunks and reopens with `createWritable({ keepExistingData: true })`. MDN specifies that existing data is first copied to the temporary writable file. Production Chromium measurement at 16 MiB showed median checkpoint time rising from 10.4 ms to 131.5 ms in one run and 39.9 ms to 186.5 ms in another. Keeping one writable open produced 2.9 ms early versus 2.4 ms late. Current Direct commit window is 1 MiB; Relay commit window is 512 KiB; Relay also caps unacknowledged frames at 8. Current Relay resend starts at a fixed 250 ms.

**Assumptions:** Chromium is the first supported large-file implementation target. OPFS `FileSystemSyncAccessHandle` is available only in a Dedicated Worker. A browser without the required safe large-file sink may reject the large transfer before claim with explicit `Environment-Dependent Size Limit` guidance. Linux network shaping is available for the dedicated WAN benchmark runner but is not required by normal `just check`.

**Blocking questions:** None. Window promotion is evidence-gated: the implementation must record whether each candidate passed; it must not force Relay to 16 chunks when the gate fails.

## Compact PRD

### Problem Statement

Large-file reception currently performs an increasing full-file copy every 128 KiB checkpoint. Receiver transfer messages are processed serially, so the growing OPFS reopen cost delays `chunk-commit`, fills the sender commit window, and makes the transfer visibly slower toward the end. The instantaneous UI speed estimator amplifies the alternating fast/slow checkpoint cadence. Separately, transport tuning lacks real WAN evidence, and Relay's fixed 250 ms initial resend can create healthy-link duplicate traffic at high RTT.

### Goals

- **G-001:** Make large-file receiver storage cost approximately linear in received bytes rather than quadratic in file size.
- **G-002:** Preserve bounded resume rollback, chunk integrity, duplicate handling, and whole-manifest completion semantics.
- **G-003:** Keep sender, receiver, Worker, and browser transport buffering strictly bounded.
- **G-004:** Give Direct and Relay independent, observable flow-control and timeout profiles.
- **G-005:** Make displayed transfer speed representative of recent useful committed throughput rather than one callback interval.
- **G-006:** Produce reproducible WAN evidence before changing the Relay default from 8 to 16 chunks or enabling adaptive windows by default.

### Non-goals

- Do not change `Share Link`, claim, `Receiver Token`, session ownership, or completion authorization.
- Do not store file contents in Durable Objects, Redis, KV, R2, or another cloud store.
- Do not add folder transfer, partial manifest selection, accounts, or application-layer passphrases.
- Do not increase the 64 KiB chunk size.
- Do not treat delivery `relay-ack` as receiver durable commit.
- Do not use a shared Direct/Relay window profile.
- Do not make normal CI depend on privileged WAN shaping.

### Users / Actors

- **Sender:** expects useful transfer progress to remain stable and bounded for a readable local source file.
- **Anonymous Receiver:** expects a large file to remain resumable without browser memory growth or end-of-file collapse.
- **Maintainer:** expects deterministic regressions, explicit performance evidence, and a recorded transport-tuning decision.

### User Stories

1. **US-001:** As a receiver, I want a large file to keep transferring at a stable storage rate, so that the final portion does not become progressively slower.
2. **US-002:** As a receiver, I want reload recovery to resume from a durable checkpoint, so that performance work does not weaken reliability.
3. **US-003:** As a sender, I want Direct and Relay to use controls appropriate to their transports, so that one mode is not over-buffered or unnecessarily throttled by the other.
4. **US-004:** As a user, I want the speed display to represent recent transfer throughput, so that bursty commit callbacks do not produce misleading values.
5. **US-005:** As a maintainer, I want a WAN matrix and machine-readable metrics, so that changing a window or retry policy is an evidence-based release decision.

### Functional Requirements

- **FR-001 / G-001:** Large-file OPFS writes must not call `createWritable({ keepExistingData: true })` once per small checkpoint or otherwise copy all previously received bytes on each checkpoint.
- **FR-002 / G-001:** A Dedicated Worker must own each active large-file OPFS handle and perform offset writes through `FileSystemSyncAccessHandle` or an equivalently proven in-place, flushable OPFS API.
- **FR-003 / G-002:** The worker sink must support open/restore, ordered offset write, flush checkpoint, bounded digest restore, finalize, close, reset, and cleanup/error reporting.
- **FR-004 / G-002:** Each 64 KiB chunk must pass file identity, index, offset, and chunk digest validation before it advances processed progress.
- **FR-005 / G-002:** `chunk-commit` may be emitted only after the corresponding worker write succeeds. Receiver re-entry/resume progress may advance only after the worker flush makes bytes durable.
- **FR-006 / G-002:** The sink must flush at EOF and whenever either unflushed bytes reach 1 MiB or one second has elapsed since the previous successful flush while new bytes exist. The byte trigger takes precedence, so unflushed data remains below 1 MiB plus one 64 KiB chunk.
- **FR-007 / G-002:** Reload/reconnect must resume from the last flushed byte boundary and may resend the unflushed tail idempotently. It must never skip unflushed bytes.
- **FR-008 / G-002:** Unsupported large-file storage, permission denial, quota exhaustion, worker crash, write failure, or flush failure must stop the affected runtime without a false `Completed Session` and show actionable retry/recreate guidance.
- **FR-009 / G-003:** Receiver main-thread-to-worker transfer must use transferable buffers or another measured bounded-copy path. It must not accumulate an unbounded `postMessage` queue.
- **FR-010 / G-003:** Direct sender commit bytes, DataChannel buffered bytes, Relay sender commit bytes, pending Relay wire bytes, and receiver worker pending bytes must be tracked separately and enforced against hard caps.
- **FR-011 / G-004:** Direct defaults remain 16 chunks / 1 MiB commit window for the initial baseline. Its adaptive range, if enabled after validation, is 8–64 chunks / 512 KiB–4 MiB, coordinated with DataChannel high/low water marks.
- **FR-012 / G-004:** Relay defaults remain 8 chunks / 512 KiB commit window and 8 unacknowledged frames until its promotion gate passes. Its absolute commit-window range is 4–16 chunks / 256 KiB–1 MiB.
- **FR-013 / G-004:** Relay delivery RTT and receiver commit RTT must be measured separately. Delivery RTT controls Relay retransmission timeout; commit RTT and useful committed throughput control the commit window.
- **FR-014 / G-004:** Relay retransmission timeout must use bounded smoothed RTT and RTT variance (`SRTT + 4 × RTTVAR`), ignore RTT samples from retransmitted frames, start conservatively at no less than 1,000 ms, and remain clamped to 500–4,000 ms. Existing 15-second terminal acknowledgement timeout remains a separate bound unless benchmark evidence requires a reviewed change.
- **FR-015 / G-004:** Any adaptive commit window must use bounded additive probe / multiplicative decrease. It may change at most once per completed window/RTT epoch, increase by at most two chunks in one epoch, halve on timeout/retransmission/sustained buffer pressure, and always clamp to the mode-specific hard bounds.
- **FR-016 / G-004:** Adaptive state belongs to one per-transfer flow-control owner and resets on transfer restart/generation change. Scheduler, queue, and UI must not independently mutate the active window.
- **FR-017 / G-005:** UI speed must use useful committed bytes over a rolling three-second sample window, require at least 500 ms between the oldest/newest contributing samples, update the displayed value at most four times per second, and reset on runtime generation change.
- **FR-018 / G-005:** When no useful committed progress occurs for two seconds during an active transfer, displayed speed must decay to zero/`--`; it must not preserve a stale peak value.
- **FR-019 / G-006:** A real-Chromium benchmark must cover Direct and Relay at 20/100/200/500 ms RTT and 0/0.5/1/3% packet loss using the actual protocol, receiver storage sink, integrity checks, and browser runtimes.
- **FR-020 / G-006:** Relay packet-loss metrics and application frame/ACK-loss metrics must remain separate because WebSocket/TCP packet loss normally appears as transport retransmission and head-of-line delay rather than missing application messages.
- **FR-021 / G-006:** Benchmark output must record useful throughput, P50/P95 delivery ACK RTT, P50/P95 commit RTT, transport retransmission rate when observable, application resend rate, wire-byte amplification, peak tracked payload/wire/transport-buffer bytes, first-progress time, completion time, and fault recovery time for fault scenarios.
- **FR-022 / G-006:** Relay 16 chunks may become the static default only when the promotion gate passes. Adaptive mode may become default only after static candidates and controller convergence both pass the same safety gate.

### Acceptance Criteria

- **AC-001:** In production Chromium, the focused OPFS oracle writes at least 64 MiB in 64 KiB chunks with the specified checkpoint policy; the late-quartile median checkpoint latency is no more than 2.0× the early-quartile median, with no repeated existing-file copy in the active write path.
- **AC-002:** Under the same harness and machine, 64 MiB elapsed write/checkpoint time is no more than 2.5× the 32 MiB time. Raw per-checkpoint timings are retained as test evidence.
- **AC-003:** Receiver reload after at least one flush resumes at exactly the last durable checkpoint. At most 1 MiB plus one chunk is resent, and final bytes/digest match the source.
- **AC-004:** Direct and forced Relay browser flows complete a large deterministic file through the worker sink and reach `Completed Session View` only after byte count and digest verification.
- **AC-005:** A duplicate committed chunk is acknowledged without rewriting; a wrong file, offset, index, or digest fails without advancing processed or durable progress.
- **AC-006:** Injected worker write, flush, quota-like, and termination failures produce no save action or completed view and release all active handles/buffer reservations.
- **AC-007:** At every observable sample, each mode's tracked buffered bytes is at or below its configured hard cap plus one active 64 KiB worker chunk. A test attempting continued production at the cap blocks rather than allocating unbounded payloads.
- **AC-008:** For a deterministic constant 1 MiB/s commit source, displayed speed after the three-second warm-up stays within ±20% of 1 MiB/s and becomes zero/`--` within 2.5 seconds after progress stops.
- **AC-009:** With a deterministic 500 ms healthy delivery RTT, warmed Relay RTO produces no pre-ACK application resend. A dropped ACK triggers bounded retransmission and exponential backoff without exceeding `maxUnacked` or byte caps.
- **AC-010:** The complete WAN matrix emits one schema-valid JSON record per scenario/repetition and a summary comparing static Direct 16/32 and Relay 8/16 candidates. Missing privileged shaping support fails early as blocked, not as a passing benchmark.
- **AC-011:** Relay 16 is promoted only if, across 200/500 ms and 0–1% loss, median useful-throughput improvement is at least 15%, 20/100 ms throughput does not regress by more than 5%, P95 delivery ACK RTT does not inflate by more than 25%, healthy-link application resend remains below 1%, tracked memory stays within caps, and reconnect/reload recovery does not regress by more than 10%.
- **AC-012:** If any Relay promotion criterion fails, the recorded decision is `retain-8`; the release remains valid with 8 chunks. No benchmark result may silently increase a production limit.
- **AC-013:** Existing Direct/Relay disclosure, resume, receiver-token ownership, sender end, retry/release, and entire-manifest integrity tests remain green.

### Edge Cases / Failure Handling

- Final chunk shorter than 64 KiB and a flush trigger occurring at EOF.
- Receiver reload between worker write completion and flush completion.
- Duplicate chunk after restart from the last durable checkpoint.
- Worker error or termination with one transferred buffer outstanding.
- OPFS lock contention from another tab/runtime generation.
- Quota exhaustion during write versus during flush.
- File finalization while a timed flush is pending.
- Sender or receiver runtime replacement while stale worker responses remain in flight.
- Relay delivery ACK arrives after an application resend; the sample must not update RTT.
- High RTT with zero packet loss must not be classified as frame loss solely because RTT exceeds the old 250 ms resend delay.
- DataChannel/WebSocket buffered bytes remain high while commit RTT is low; window growth must stop.
- Browser lacks Dedicated Worker OPFS sync access; large receive must fail before consuming content.

### Constraints

- Preserve `Direct Transfer`, `Relayed Transfer`, `Frozen Manifest`, `Receiver Token`, `Temporary Session Window`, and `Completed Session View` terminology.
- Preserve the 64 KiB protocol/checkpoint alignment unit.
- Do not weaken `Share Link` bearer-credential handling or expose file metadata in generic previews.
- `packages/shared` remains runtime-light and must not depend on browser, React, Hono, Redis, or Worker implementations.
- Respect `constraints.yaml`, dependency boundaries, Biome, TypeScript strictness, and the canonical `just` command surface.

### Out of Scope

- Upload-to-cloud fallback or server-side chunk persistence.
- Mobile native apps, desktop clients, PWA-first behavior, or background transfer after closing the browser.
- Dynamic chunk sizing, compression, deduplication, erasure coding, or partial file selection.
- Production deployment, paid WAN infrastructure, or a claim of universal 100G/1000G real-world support.

## Execution Spec

### Goal

Replace the quadratic OPFS checkpoint path with a worker-owned, in-place, flushable large-file sink; preserve resumability and integrity; then add bounded transport-specific control, stable speed reporting, and evidence-gated WAN tuning.

### Scope

#### In scope

- A Dedicated Worker protocol and sink lifecycle for large OPFS files.
- Receiver protocol/runtime integration and safe capability failure.
- Durable checkpoint and restart behavior.
- Rolling speed calculation shared by sender/receiver UI owners.
- Relay ACK RTT/RTO telemetry and bounded retry timing.
- Independent Direct/Relay flow-control profiles and optional bounded controller.
- Deterministic throughput/storage oracles and real-Chromium shaped-network benchmark runner.

#### Out of scope

- Session API/state schema changes unless implementation discovers a required durable-progress contract mismatch.
- Cloudflare storage of file bytes.
- Automatic release of a new limit without benchmark evidence and reviewable decision output.
- Normal CI execution of the full WAN matrix.

### Relevant Context

- `OpfsSink.write()` currently closes every `OPFS_CHECKPOINT_CHUNKS = 2` and later reopens with `keepExistingData: true`.
- `receiver-runtime.ts` serializes transfer messages through `processingChain`, so sink latency directly delays commit progress.
- `receiver-protocol.ts` emits `chunk-commit` after sink write and keeps re-entry progress at `sink.durableBytes`.
- `transfer-scheduler.ts` snapshots a static `maxInFlightBytes` and retains chunk buffers until commit.
- `RelayMessageQueue` separately retains encoded frames until delivery ACK and uses fixed initial resend delay.
- `home-flow.ts` and `receive-flow-claim.ts` calculate speed from two adjacent progress callbacks.
- Existing `throughput-ceiling.test.ts` proves pipelining but does not model OPFS, bandwidth, packet loss, browser memory, or Worker relay.

### Terms / Assumptions

- **Processed bytes:** bytes whose chunk was validated and written successfully to the active receiver sink.
- **Durable bytes:** the greatest contiguous byte offset included in a successful OPFS flush and safe for receiver reload/re-entry reporting.
- **Delivery ACK RTT:** first transmission of a Relay frame to matching `relay-ack`; excludes retransmitted samples.
- **Commit RTT:** chunk send to matching receiver `chunk-commit`, including receiver validation and sink write.
- **Useful throughput:** newly committed source bytes divided by elapsed time; duplicate/resend bytes are excluded.
- **Tracked memory:** application-known payload buffers, encoded pending wire frames, and browser-exposed transport buffered bytes. It does not claim to equal full browser RSS.
- **Clean epoch:** one completed active window with progress, no timeout/resend, and no sustained transport-buffer pressure.

### Affected Surfaces

- **Code:** `apps/web/src/lib/transfer/receiver-sinks.ts`, `receiver-protocol.ts`, `receiver-runtime.ts`, `transfer-scheduler.ts`, `sender-runtime-helpers.ts`, `relay-queue.ts`, `runtime-shared.ts`, transfer exports/types, sender/receiver route flow helpers, and a new purpose-named Dedicated Worker module under `apps/web/src/lib/transfer/`.
- **Data / schema:** New internal main-thread/worker message schemas. No server persistence or public protocol change expected. Benchmark JSON schema and raw samples are local artifacts.
- **API / CLI / UI:** Existing sender/receiver UI plus new focused benchmark command. No public HTTP API change expected.
- **Tests:** Bun unit/integration, Playwright browser/Worker E2E, Chromium OPFS performance oracle, Linux WAN benchmark.
- **Docs / ops:** This spec and a benchmark decision artifact outside runtime source. Add canonical command routing only for implemented benchmark entry points.

### Technical Direction

#### 1. Qualify the OPFS performance oracle before changing production code

- Preserve the current red reproduction: 64 KiB writes, two-chunk checkpoint cadence, growing OPFS file, and early/middle/late latency breakdown.
- Demonstrate that the oracle catches the current progressive slowdown and that a single open writer control remains flat.
- Keep the final regression at 32/64 MiB so it is strong enough to expose copy growth but bounded enough for a focused browser run.
- The test must exercise browser OPFS behavior, not inspect source text for `keepExistingData`.

#### 2. Introduce one worker-owned large-file lifecycle

Define a tagged internal worker protocol with generation/session/file identity on every command and response:

```ts
type SinkWorkerCommand =
  | { type: "open"; generation: number; sessionId: string; file: FileManifestItem }
  | { type: "restore-digest"; generation: number; fileId: string; durableBytes: number }
  | { type: "write"; generation: number; fileId: string; chunkIndex: number; offset: number; bytes: ArrayBuffer }
  | { type: "flush"; generation: number; fileId: string; reason: "bytes" | "timer" | "eof" }
  | { type: "finalize"; generation: number; fileId: string }
  | { type: "reset"; generation: number; fileId?: string };
```

Responses must identify the same generation/file/chunk and distinguish processed bytes, durable bytes, digest/finalization, and typed storage failure. Stale-generation responses are ignored after their resources are closed; they must never update the active runtime.

Worker invariants:

- One lifecycle owner per active file handle.
- One ordered write at a time per file in the first implementation.
- `write()` returns processed progress only after `FileSystemSyncAccessHandle.write()` reports the full chunk length.
- `flush()` advances durable progress only after `flush()` succeeds.
- Digest restore reads at most one 64 KiB block at a time up to durable bytes.
- `finalize` flushes, verifies size/digest contract, closes the sync handle, and returns the saveable result metadata/blob path.
- All success, failure, reset, runtime replacement, and termination paths release the sync access handle and pending byte reservation.
- Main thread transfers chunk buffers to the worker; ownership and digest responsibilities must avoid a second full chunk copy. Prefer worker ownership of the incremental whole-file digest after main-thread chunk-digest validation.

#### 3. Preserve progress and resume semantics

- Main thread validates sequence/file/offset/chunk digest before worker dispatch.
- Worker write success permits `chunk-commit`, releasing sender in-flight bytes.
- Worker flush success updates `committedBytesByFileId` used by `receiver-ready` and reload recovery.
- On reload, reopen the OPFS file, read only the durable prefix in bounded 64 KiB blocks to restore the file digest, and request resend from the durable boundary.
- If a processed but unflushed tail existed, duplicate chunks at/after the durable boundary overwrite the same offsets and remain idempotent.
- EOF always flushes before file finalization and before `Completed Session` can be reached.

#### 4. Replace instantaneous speed sampling

- Add one small transfer-rate sampler owned by each active runtime generation.
- Store only the bounded samples needed for the last three seconds.
- Feed it monotonic useful committed-byte totals and `performance.now()` timestamps.
- Never calculate a sample from negative progress after reconnect; reset the sampler instead.
- Sender and receiver UI consume the same behavioral contract without sharing mutable global state.
- Keep speed presentation separate from flow-control telemetry; UI smoothing must not feed the adaptive controller.

#### 5. Separate transport observability and retry timing

Relay queue must expose bounded local telemetry without server persistence:

- original send timestamp;
- first/last send timestamp;
- attempts;
- encoded wire bytes;
- delivery ACK RTT eligible/ineligible flag;
- pending wire bytes and peak;
- NACK/timeout reason.

Use an RFC-style SRTT/RTTVAR estimator with Karn sampling and clamped RTO. Keep delivery ACK timeout and receiver commit timeout separate. A late ACK after retransmission resolves the pending frame but does not update RTT.

Direct telemetry uses DataChannel `bufferedAmount`, selected transport diagnostics, chunk commit RTT, useful throughput, and current commit bytes. Relay telemetry adds WebSocket `bufferedAmount`, pending encoded wire bytes, delivery RTT, commit RTT, and application resend count.

#### 6. Add mode-specific bounded flow control

- Replace the scheduler's frozen numeric lookup with a read-only `currentMaxInFlightBytes()` supplied by the per-transfer flow-control owner, or an equivalently small interface.
- Keep `maxActiveFiles` independent from byte-window adaptation.
- Fill only up to the current byte cap. A reduced cap does not cancel in-flight chunks; it stops new sends until accounting falls below the new cap.
- Direct controller coordinates its commit cap with DataChannel high/low water thresholds.
- Relay commit controller never mutates `maxUnacked`; delivery-frame capacity remains a separate hard bound.
- Controller decisions and reasons are recordable in test events but are not persisted as session history.
- Ship static baseline profiles first. Enable candidate/adaptive profiles only through the benchmark configuration until the release gate selects a default.

#### 7. Build the WAN benchmark and decision gate

Add a non-default command surface, for example `just bench-wan`, backed by a checked-in runner. The implementation may choose the exact script path, but it must be discoverable from `just --list` and fail early when Linux shaping/network namespace prerequisites are absent.

Scenario dimensions:

```text
mode: direct | relay
RTT ms: 20 | 100 | 200 | 500
packet loss %: 0 | 0.5 | 1 | 3
static window candidates:
  direct: 16 | 32 chunks
  relay: 8 | 16 chunks
repetitions: 1 warm-up + at least 3 recorded
```

Use deterministic file bytes and an actual Chromium sender/receiver flow. Shape both directions and verify the requested transfer mode from diagnostics/UI. Relay application frame/ACK-drop scenarios run separately from packet-loss scenarios.

Each record must include environment identity, browser version, code revision supplied by the caller, mode, candidate, network settings, useful bytes, elapsed times, RTT distributions, retries, amplification, tracked peaks, final integrity result, and failure/recovery classification. Raw evidence belongs in a caller-owned output directory and is not committed by default.

The runner must emit a deterministic decision summary:

```text
relayWindowDecision: promote-16 | retain-8
adaptiveDefaultDecision: enable | retain-static
reasons: string[]
```

No runtime config changes itself based on a local benchmark run; implementation applies the reviewed decision in source/config and reruns focused/full validation.

### Validation Plan

- **VAL-001:** Current OPFS path reproduces progressive slowdown; replacement stays within AC-001/AC-002. Surface: real browser storage. Evidence: targeted Playwright/browser harness stdout plus raw checkpoint JSON.
- **VAL-002:** Worker command lifecycle enforces generation, ordering, byte reservations, flush progress, reset, and failure cleanup. Surface: worker/domain boundary. Evidence: focused unit/browser tests.
- **VAL-003:** Direct large-file receive completes through worker sink with matching bytes/digest. Surface: browser business flow. Evidence: targeted Playwright stdout and final DOM/save assertion.
- **VAL-004:** Forced Relay large-file receive completes through the same sink and preserves mode disclosure. Surface: Worker/browser business flow. Evidence: targeted Worker Playwright stdout and DOM assertion.
- **VAL-005:** Receiver reload resumes from the last flushed boundary with bounded resend. Surface: browser recovery flow. Evidence: transfer event trace showing durable offset, resent range, and final digest.
- **VAL-006:** Storage capability/quota/write/flush/worker failures cannot produce false completion. Surface: browser storage + UI. Evidence: targeted tests and error-state DOM.
- **VAL-007:** Speed sampler meets AC-008 under constant and bursty progress. Surface: UI/domain boundary. Evidence: focused Bun tests and one browser assertion.
- **VAL-008:** Relay RTO meets AC-009 and preserves queue bounds/reset semantics. Surface: queue/service boundary. Evidence: deterministic fake-clock/timer tests.
- **VAL-009:** Direct/Relay static and adaptive controllers obey byte bounds, epoch cadence, increase/decrease rules, and generation reset. Surface: scheduler/controller boundary. Evidence: deterministic unit/property tests.
- **VAL-010:** WAN matrix and decision schema meet AC-010–AC-012. Surface: CLI + browser. Evidence: command stdout, scenario JSONL, summary JSON.
- **VAL-011:** Existing focused transfer suites pass after each behavior change. Surface: unit/integration/browser. Evidence: exact targeted commands selected from affected files.
- **VAL-012:** Final repository validation passes. Surface: canonical repo command. Evidence: `just check` stdout and exit code 0. The WAN matrix remains a separate explicit gate.

Suggested focused commands after implementation establishes the named files:

```bash
bun test apps/web/src/lib/transfer/receiver-protocol*.test.ts
bun test apps/web/src/lib/transfer/relay-queue.test.ts
bun test apps/web/src/lib/transfer/transfer-scheduler.test.ts
bun test apps/web/src/lib/transfer/throughput-ceiling.test.ts
bunx playwright test <targeted direct large-file spec>
bunx playwright test -c tests/e2e/worker.playwright.config.ts <targeted relay large-file spec>
just check
just bench-wan   # explicit Linux/manual performance gate, not part of just check
```

New test paths are intentionally not fabricated here; implementation must use purpose-named files that satisfy repository naming and file-length guards.

### Requirements Traceability

| Goal | Requirements | Acceptance | Validation |
|---|---|---|---|
| G-001 linear storage | FR-001–FR-003 | AC-001, AC-002 | VAL-001, VAL-002 |
| G-002 resume/integrity | FR-004–FR-008 | AC-003–AC-006, AC-013 | VAL-003–VAL-006, VAL-011 |
| G-003 bounded resources | FR-009–FR-010 | AC-007 | VAL-002, VAL-009 |
| G-004 mode-specific control | FR-011–FR-016 | AC-009, AC-011–AC-013 | VAL-008–VAL-012 |
| G-005 honest speed | FR-017–FR-018 | AC-008 | VAL-007 |
| G-006 WAN evidence | FR-019–FR-022 | AC-010–AC-012 | VAL-010 |

### Risks / Open Questions

- **RISK-001:** `FileSystemSyncAccessHandle` browser support is not universal. Mitigation: Chromium-first capability gate and explicit large-file limitation before transfer.
- **RISK-002:** Transferring a chunk buffer to the worker can conflict with main-thread whole-file digest ownership. Mitigation: move incremental whole-file digest ownership into the sink worker or prove a bounded no-copy alternative.
- **RISK-003:** Worker crash between write and flush leaves a processed but non-durable tail. Mitigation: re-entry reports only flushed bytes and resends/overwrites the tail.
- **RISK-004:** `flush()` latency may still fluctuate with storage pressure. Mitigation: byte/time checkpoint policy, bounded sender window, explicit P95 evidence, and no full-file-copy loop.
- **RISK-005:** Browser transport buffers are not fully represented by JS heap. Mitigation: report tracked application bytes, browser-exposed `bufferedAmount`, and process metrics separately; do not label them total memory.
- **RISK-006:** Linux packet shaping may not model all public WAN/Cloudflare behavior. Mitigation: call it controlled Chromium WAN evidence, retain raw environment identity, and do not claim production proof.
- **RISK-007:** Adaptive control can oscillate or amplify retries. Mitigation: static baselines first, hard bounds, epoch-limited changes, deterministic convergence tests, and evidence-gated default enablement.
- **Deferred detail:** Exact worker bundling URL pattern should follow the existing Vite/TypeScript convention discovered during implementation.
- **Deferred detail:** Exact caller-owned benchmark output directory flag should follow existing QA evidence conventions without storing artifacts under `.agents/qa`.

### Mission Handoff

Suggested milestones:

1. **Qualify the storage oracle and worker contract**
   - Run the current OPFS red reproduction.
   - Add internal worker message types and lifecycle tests.
   - Required evidence: old-path early/late slowdown, single-writer control, worker contract failures.

2. **Cut over large-file storage**
   - Implement worker-owned sync access sink.
   - Remove the active large-file `close → createWritable({ keepExistingData: true })` checkpoint loop.
   - Preserve small-file memory sink.
   - Required evidence: AC-001/AC-002 and storage failure tests.

3. **Seal resume and integrity parity**
   - Integrate processed versus durable progress.
   - Verify Direct and forced Relay completion/reload from flushed boundary.
   - Required evidence: event trace, final bytes/digest, no false completion.

4. **Make speed and transport telemetry trustworthy**
   - Add bounded rolling speed sampler.
   - Add Relay delivery/commit RTT, resend, and retained-byte telemetry.
   - Replace fixed initial Relay resend timing with bounded SRTT/RTTVAR RTO.
   - Required evidence: AC-008/AC-009.

5. **Add independent bounded flow profiles**
   - Keep static production defaults.
   - Implement/test candidate/adaptive controllers behind benchmark configuration.
   - Required evidence: hard-cap and convergence tests for Direct and Relay.

6. **Run WAN gate and apply the decision**
   - Execute the complete Chromium matrix on a qualified Linux host.
   - Emit raw JSONL and decision summary.
   - Apply only a passing reviewed limit/default decision.
   - Required evidence: AC-010–AC-012.

7. **Release validation**
   - Run targeted browser flows, focused unit suites, then `just check`.
   - Keep the WAN result as separate explicit release evidence.

Required evidence:

- Exact command and exit code.
- Qualified red/green OPFS timing output.
- Raw per-checkpoint and WAN scenario records.
- Direct and Relay final integrity assertions.
- Resume event trace showing flushed boundary and resent tail.
- Buffer-cap peak records.
- RTO/retransmission traces for 500 ms healthy and dropped-ACK cases.
- Relay promotion/default decision JSON with reasons.
- Final `just check` output.

Human gates:

- Review any source/config change that raises a hard memory/window limit.
- Approve enabling adaptive windows by default after WAN evidence.
- Authorize any production deployment or production-environment benchmark separately.

## Readiness

**Readiness: Ready**

**Reason:** The spec identifies the verified root cause, preserves product/reliability boundaries, defines measurable performance and durability contracts, names affected seams, separates Direct/Relay controls, provides an evidence-gated WAN decision, and has no build-blocking ambiguity for Chromium-first implementation.

**Next:** Implement milestone 1 and prove the current OPFS oracle red before changing the receiver sink.