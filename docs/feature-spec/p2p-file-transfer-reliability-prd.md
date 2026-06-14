# P2P File 大文件与多文件传输稳定性 PRD

- **状态**: Local PRD Draft
- **日期**: 2026-06-12
- **版本**: reliability-upgrade
- **保存范围**: 本地文档；不创建 GitHub issues
- **相关文档**: `CONTEXT.md`, `docs/mvp-product-rules.md`, `docs/feature-spec/p2p-file-first-version-feature-spec.md`, `AGENTS.md`
- **当前代码参考**: `apps/web/src/lib/transfer/*`, `apps/web/src/routes/received-file-cache.ts`, `apps/edge/src/session-durable-object.ts`, `packages/shared/src/session.ts`

## 1. Goal

提升 P2P File 在大文件、多文件和不稳定网络下的传输稳定性与用户体验，让 `Direct Transfer` 与 `Relayed Transfer` 都能在可恢复连接中继续传输，并避免真实大文件进入整文件内存聚合路径。

核心目标：

- 网络短暂掉线不应直接变成 `Sender-Ended Session` 或不可恢复失败。
- 大 ZIP 或其他大文件中途掉线后，应从已确认的断点继续，而不是从当前文件开头重传。
- 多文件传输不应被单个大文件长时间阻塞；接收端应能看到每个文件的状态。
- 真实大文件应使用流式接收与本地持久化 sink，不依赖 `new Blob(allChunks)`。
- Cloudflare 继续作为 `Signaling Service`、session ownership、控制面状态和 relay 转发层，不保存文件内容。

## 2. Product scope

### 2.1 In scope

- **FR-001**: 意外断线进入可恢复 reconnecting 状态；显式 sender end 仍进入 `Sender-Ended Session`。
- **FR-002**: 原 `Receiver Token` holder 可在同一 `Claimed Session` 内恢复接收进度。
- **FR-003**: `Direct Transfer` 支持 chunk-level commit 与断点续传。
- **FR-004**: `Relayed Transfer` 支持同一断点续传语义，relay ack 不再代表 receiver 已处理完成。
- **FR-005**: 接收端支持流式写入本地持久化 sink，用于大文件和断点续写。
- **FR-006**: 多文件传输使用有界并发与全局 backpressure，避免单个大文件独占整个 transfer。
- **FR-007**: UI 显示 reconnecting、resuming、per-file progress、transfer mode、receiver write/backpressure 等可理解状态。
- **FR-008**: `Completed Session` 仍必须满足 `Integrity-Gated Completion`，且覆盖整个 `File Manifest`。

### 2.2 Out of scope

- **NFR-001**: 不引入上传到云存储的 fallback；文件内容仍走 peer path 或 relay transport。
- **NFR-002**: 不把文件 chunk 存入 Cloudflare Durable Object、KV、R2 或业务服务器。
- **NFR-003**: 不把 `Share Link` 变成持久下载页；`Temporary Session Window` 和 `Completed Session View` 仍是短暂会话模型。
- **NFR-004**: 不支持接收方挑选部分文件；`File Manifest` 仍作为整体接收。
- **NFR-005**: 不承诺 universal unlimited size；仍使用 `Environment-Dependent Size Limit`，但协议和接收路径要能覆盖 `1G/10G/100G/1000G` logical sizes。
- **NFR-006**: 不引入用户账号、设备身份、命名 receiver 或额外 passphrase。

## 3. Current problem statement

当前实现已经支持文件级 retry，但恢复点只有：

```ts
receiver-ready: { completedFiles: number }
```

这导致当前能力是：

```text
文件 1 完成，文件 2 传到 60% 后断线
=> 重连后从文件 2 开头重新传
```

对多个小文件可接受；对单个 10G/100G ZIP 不可接受。

当前接收端还会在 `receiver-protocol.ts` 中执行：

```text
chunk -> currentChunks.push(bytes)
file-end -> new Blob(currentChunks)
```

这意味着真实大文件会线性消耗内存/浏览器存储，并且中途断线后当前文件的 partial chunks 不能安全恢复。

当前 Cloudflare Durable Object 只保存 session metadata 和 receiver ownership，不保存进度 vector、chunk ledger 或 relay sequence ledger。WebSocket 对端不在线时，合法 signal 可能被静默丢弃。

## 4. Product requirements

- **REQ-001**: 用户网络短暂中断时，sender 和 receiver UI 必须进入可理解的 reconnecting 状态，而不是立即失败。
- **REQ-002**: sender 显式结束与意外断线必须区分；只有显式结束才是 `Sender-Ended Session`。
- **REQ-003**: receiver 重进时必须发送 progress vector，描述每个 manifest item 的 completion 与 committed bytes。
- **REQ-004**: sender 必须只发送 receiver 尚未 commit 的 chunk。
- **REQ-005**: receiver 只有在 chunk 校验并写入持久化 sink 后，才发送 commit ack。
- **REQ-006**: chunk message 必须包含 `fileId`, `chunkIndex`, `offset`, `bytes`, `chunkDigest`。
- **REQ-007**: receiver 必须幂等处理重复 chunk，并拒绝 wrong file / wrong offset / wrong digest。
- **REQ-008**: `Direct Transfer` 和 `Relayed Transfer` 必须共享同一 resume semantic。
- **REQ-009**: 大文件接收路径不能依赖完整 `ArrayBuffer[]` 聚合或完整 `Blob` 聚合。
- **REQ-010**: 多文件传输必须有 bounded concurrency 和全局 in-flight byte window。
- **REQ-011**: UI 必须展示总进度、每文件进度、当前 mode、重连状态和可恢复失败原因。
- **REQ-012**: `Completed Session` 只能在整个 `File Manifest` 全部完整性校验通过后成立。

## 5. Architecture decisions

### 5.1 Reconnectable session semantics

- 意外 sender socket close 不再立即标记 `Sender-Ended Session`。
- Session 进入 reconnect grace window。
- 原 sender 通过 sender token 重新连接后继续同一 `Temporary Session Window`。
- sender 显式 `sender-left` / end API 仍立即进入 `Sender-Ended Session`。
- 超过 grace window 未恢复时进入明确 failed state，并给 receiver 可理解说明。

This changes the first-version rule that sender refresh/page exit always ends the live session. For this reliability upgrade, accidental disconnect is recoverable; explicit sender end remains terminal.

### 5.2 Resume progress vector

替代 completed-files-only resume。

Minimum shape:

```ts
type ResumeProgress = {
  manifestHash: string;
  files: Array<{
    fileId: string;
    size: number;
    chunkSize: number;
    committedBytes: number;
    completed: boolean;
  }>;
};
```

Rules:

- `manifestHash` must match the `Frozen Manifest`.
- `committedBytes` must be aligned to chunk boundaries except final chunk.
- Completed files must have `committedBytes === size`.
- Sender must never trust progress for a file not present in the manifest.

### 5.3 Chunk commit protocol

Chunk message:

```ts
type TransferChunk = {
  type: "chunk";
  fileId: string;
  chunkIndex: number;
  offset: number;
  bytes: ArrayBuffer;
  chunkDigest: string;
};
```

Commit ack:

```ts
type ChunkCommitAck = {
  type: "chunk-commit";
  fileId: string;
  chunkIndex: number;
  committedBytes: number;
};
```

Rules:

- Sender advances the durable send cursor only after commit ack.
- Receiver sends commit ack only after write + digest verification + local ledger update.
- Duplicate committed chunks are acked idempotently without rewriting.
- Out-of-order chunks are either rejected or buffered within a bounded window; first implementation should prefer strict offset order unless bounded reordering is explicitly needed.

### 5.4 Receiver streaming sink

Default decision:

1. Use File System Access API when available and user grants permission.
2. Use OPFS staging where direct writable user file handles are unavailable but OPFS is available.
3. Keep Blob path only for small files that fit the existing safe memory threshold.
4. If no safe sink exists for a large file, block before transfer starts with a recoverable UI message.

The receiver sink must support:

- offset write
- checkpointed committed bytes
- finalization into a saveable/openable received file
- cleanup on release/failure/expiration
- clear errors for permission denied and quota exceeded

### 5.5 Relayed Transfer semantics

Cloudflare Worker / Durable Object remains control and forwarding infrastructure:

- Stores session metadata, receiver ownership, reconnect grace state, and compact progress metadata.
- Does not store file content or chunk bodies.
- Does not claim relay ack means receiver committed bytes.

Relay frame delivery and receiver commit are separate:

```text
relay frame received by browser != chunk committed by receiver
```

### 5.6 Bounded multi-file concurrency

Initial scheduler constraints:

- `maxActiveFiles`: 2 by default.
- `maxInFlightBytes`: bounded global window, implementation-tuned.
- Small files should be eligible to finish while a large file is still active.
- Direct and relay paths share the same scheduler decisions.
- Backpressure is controlled by receiver commit acks and local sink write speed.

## 6. Vertical delivery slices

Granularity decision: do not create one giant “make large transfer stable” task; it is too coarse and hides independent failure modes. Also do not split schema, UI, tests, and storage into separate tickets; those are horizontal and not independently demoable. The right breakdown is six vertical slices, each producing user-visible behavior and its own verification.

### Slice 1 — Recoverable peer reconnect at file boundary

- **Type**: AFK
- **Blocked by**: None

Build reconnecting state across session control, sender/receiver runtimes, and UI. This slice keeps current file-boundary resume behavior but stops treating accidental disconnect as immediate terminal failure.

Acceptance criteria:

- [ ] Sender explicit end still creates `Sender-Ended Session`.
- [ ] Sender accidental WebSocket close enters reconnect grace state.
- [ ] Receiver accidental disconnect can reconnect with the same `Receiver Token`.
- [ ] UI shows reconnecting / waiting-for-peer state with clear recovery guidance.
- [ ] E2E verifies a transfer interrupted between files resumes without creating a new Share Link.

### Slice 2 — Direct Transfer resumable single large file

- **Type**: AFK
- **Blocked by**: Slice 1

Build the first true chunk-level resume path for one large file over `Direct Transfer`. Includes progress vector, chunk commit ack, receiver streaming sink, and completed-file finalization for a single-file `File Manifest`.

Acceptance criteria:

- [ ] Receiver reports committed bytes for the active file.
- [ ] Sender resumes `File.slice()` from committed offset after reconnect.
- [ ] Receiver writes chunks to a streaming sink, not `currentChunks -> Blob`, for large files.
- [ ] Duplicate committed chunks are idempotently acked.
- [ ] Wrong offset, wrong file, and wrong digest fail safely.
- [ ] E2E verifies a large ZIP interrupted mid-file resumes from the committed offset.

### Slice 3 — Relayed Transfer resumable single large file

- **Type**: AFK
- **Blocked by**: Slice 2

Apply the same chunk commit protocol to `Relayed Transfer`. Relay forwarding remains stateless for file content; receiver commit ack becomes the source of truth for progress.

Acceptance criteria:

- [ ] Relay ack no longer represents receiver commit.
- [ ] Receiver commit ack is sent only after chunk write and verification.
- [ ] Relay timeout/reconnect resumes from committed offset.
- [ ] Worker WebSocket messages stay below Cloudflare 32 MiB received-message limit.
- [ ] Worker E2E verifies forced direct failure + relay mid-file interruption + resume.

### Slice 4 — Multi-file resume vector across the full File Manifest

- **Type**: AFK
- **Blocked by**: Slice 3

Extend resume from one file to the complete `File Manifest`: each file has completed/committed progress, receiver re-entry restores the whole progress vector, and sender skips committed work.

Acceptance criteria:

- [ ] Progress vector covers every manifest item.
- [ ] Completed files are skipped on resume.
- [ ] Partially received file resumes at committed bytes.
- [ ] Later unstarted files remain queued.
- [ ] `Completed Session` is reached only after all files pass integrity checks.
- [ ] E2E verifies multi-file interrupted transfer resumes without re-sending completed files or committed chunks.

### Slice 5 — Bounded multi-file concurrent receiving

- **Type**: AFK
- **Blocked by**: Slice 4

Introduce bounded multi-file scheduling so small files can complete while large files continue. The scheduler must preserve `File Manifest` integrity and use global backpressure.

Acceptance criteria:

- [ ] Multiple files can be active within `maxActiveFiles`.
- [ ] Global `maxInFlightBytes` prevents unbounded buffered data.
- [ ] Small files can complete before a large file finishes.
- [ ] Per-file state is visible: queued, receiving, reconnecting, completed, failed.
- [ ] Direct and relay paths follow the same scheduling invariants.
- [ ] E2E verifies small files plus a large ZIP complete with correct per-file and total progress.

### Slice 6 — Large-transfer reliability release gate

- **Type**: AFK
- **Blocked by**: Slice 5

Seal the feature with deterministic stress coverage, runtime evidence, and cleanup. This is not a separate feature surface; it is the release gate that proves the new behavior end-to-end.

Acceptance criteria:

- [ ] Unit tests cover resume vector normalization, chunk ledger, commit ack, duplicate chunk, bad digest, bad offset, and manifest mismatch.
- [ ] Browser E2E covers Direct Transfer receiver reload mid-file.
- [ ] Worker E2E covers Relayed Transfer reconnect mid-file.
- [ ] Virtual file tests cover `1G`, `10G`, `100G`, `1000G` logical sizes without whole-file allocation.
- [ ] A real-browser smoke covers at least one large ZIP using streaming sink and confirms memory does not grow linearly with file size.
- [ ] `just check` passes after the reliability suite is integrated or explicitly callable.

## 7. Dependency graph

```text
Slice 1 Recoverable peer reconnect
  -> Slice 2 Direct resumable single large file
    -> Slice 3 Relay resumable single large file
      -> Slice 4 Multi-file resume vector
        -> Slice 5 Bounded multi-file concurrent receiving
          -> Slice 6 Large-transfer reliability release gate
```

Rationale:

- Reconnect semantics must land first; otherwise resume has no stable lifecycle to attach to.
- Direct chunk resume should land before relay resume because it defines the browser-side commit protocol without relay complexity.
- Relay resume then reuses the same commit protocol and proves fallback parity.
- Multi-file resume depends on single-file resume being correct.
- Multi-file concurrency depends on per-file progress and commit semantics.
- Release gate comes last because it validates the integrated behavior rather than one layer.

## 8. UX requirements

Sender UI must show:

- current `Transfer Mode Disclosure`
- reconnecting / resumed state
- total progress
- active file list and per-file progress
- when fallback switches from `Direct Transfer` to `Relayed Transfer`
- clear terminal distinction between explicit sender end and failed recovery

Receiver UI must show:

- save-location requirement before large transfer starts
- permission denied / quota exceeded recovery guidance
- reconnecting / waiting for sender state
- resuming from committed progress
- per-file queued / receiving / completed / failed state
- `Completed Session View` only after entire `File Manifest` passes integrity checks

## 9. Validation plan

### Unit / integration

- Resume progress vector schema parsing and normalization.
- Chunk offset/index validation.
- Chunk digest verification.
- Duplicate committed chunk idempotency.
- Receiver ledger restore after reload.
- Sender resend from committed offset only.
- Relay commit ack ordering.
- Backpressure window accounting.

### Browser E2E

- Direct Transfer happy path still works.
- Direct Transfer receiver reload mid-file resumes.
- Direct Transfer sender reconnect within grace resumes.
- Relayed Transfer forced path resumes mid-file.
- Multi-file session with small files and a large ZIP completes.
- Permission denied before large receive gives recoverable UI.
- Storage/quota failure gives explicit failure reason.

### Large-size coverage

- Virtual files: `1G`, `10G`, `100G`, `1000G` logical sizes.
- Real browser smoke: at least one large ZIP using streaming sink.
- Memory assertion: no full-file `ArrayBuffer[]` or `Blob` aggregation on large path.

### Commands

- Targeted unit tests for transfer modules while iterating.
- Targeted Playwright tests for direct/worker transfer flows.
- `just check` before reporting the integrated reliability upgrade complete.

## 10. Risks and mitigations

- **RISK-001**: File System Access API browser support varies.
  - **Mitigation**: Use OPFS fallback where available; fail before transfer with clear guidance where no safe sink exists.
- **RISK-002**: OPFS quota may be insufficient for very large files.
  - **Mitigation**: Estimate available storage before transfer and surface quota errors explicitly.
- **RISK-003**: More protocol state increases invalid transition risk.
  - **Mitigation**: Model transfer lifecycle as explicit state machines and validate every state transition in tests.
- **RISK-004**: Relay base64 encoding adds CPU and size overhead.
  - **Mitigation**: Keep chunk size well below 32 MiB; consider binary relay frame optimization after resume semantics are stable.
- **RISK-005**: Multi-file concurrency may over-buffer.
  - **Mitigation**: Enforce global in-flight byte window and receiver-driven backpressure.

## 11. Implementation guardrails

- Preserve domain terms from `CONTEXT.md`.
- Keep `packages/shared` runtime-light: schemas, types, constants, protocol helpers only.
- Keep file content off Cloudflare storage.
- Treat `Share Link` as a bearer credential.
- Do not introduce upload-to-cloud fallback.
- Do not add compatibility shims for old protocol paths after clean cutover; update all callers and tests.
- Do not claim `100G/1000G` real-world support until receiver streaming sink and browser/storage caveats are enforced in product behavior.
