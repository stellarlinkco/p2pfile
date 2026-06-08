# P2P File 第一版网站 Feature Spec

- **状态**: Mission Ready
- **日期**: 2026-06-08
- **版本**: v1
- **质量评分**: 90/100
- **相关文档**: `CONTEXT.md`, `docs/mvp-product-rules.md`, `AGENTS.md`
- **Existing code references**: `CONTEXT.md`, `docs/mvp-product-rules.md`, `AGENTS.md`; 业务代码 TBD - infer during mission

## 1. Goal

- **Goal**: 构建一个 browser-first 的 P2P File 网站，让用户无需先上传到云端即可在浏览器中直接传文件，默认点对点直传，必要时自动切换中继。
- **Primary promise**: 无需先上传到云端，浏览器直接传文件。
- **Mission-ready decision**: 第一版是普通网站，不做 PWA 产品承诺，不做桌面客户端，不做 CLI。

## 2. Scope

### 2.1 In scope
- **FR-001**: Browser ↔ Browser 文件传输。
- **FR-002**: 发送方支持单文件与多文件；不支持文件夹。
- **FR-003**: 一个会话对应一个冻结的 `Frozen Manifest`，接收方必须整体接收，不支持部分挑选。
- **FR-004**: 主入口为 `Share Link`，辅入口为 `Access Code`，并提供 `QR Code`。
- **FR-005**: 单发送方、单接收方、单占用会话模型。
- **FR-006**: 默认 `Direct Transfer`，失败后自动切换 `Relayed Transfer`，并明确披露当前模式。
- **FR-007**: 接收方 claim 前仅可见 manifest 元数据，不可见文件内容预览。
- **FR-008**: 完成后进入短暂只读结果态 `Completed Session View`。

### 2.2 Out of scope
- **NFR-001**: 不做文件夹传输。
- **NFR-002**: 不做部分文件接收。
- **NFR-003**: 不做 sender reattach / sender refresh 恢复。
- **NFR-004**: 不做 PWA、桌面客户端、CLI、局域网自动发现。
- **NFR-005**: 不做应用层二次口令或额外 passphrase。
- **NFR-006**: 不做可持久查询的传输历史页。

## 3. Confirmed product requirements

- **REQ-001**: 用户可以选择文件后执行 `Session Creation`，得到一个 `Temporary Session Window` 与冻结后的 `Frozen Manifest`。
- **REQ-002**: `Share Link`、`Access Code`、`QR Code` 必须指向同一个会话，而不是三个不同入口模型。
- **REQ-003**: 接收方打开链接后，在 claim 前可以看到文件名、数量、单文件大小、总大小，但不能看到内容缩略图或预览。
- **REQ-004**: 接收方点击“接收全部文件”时 claim 会话并获得 `Receiver Token`；此时其他访客必须看到 `Occupied Session Notice`。
- **REQ-005**: 多文件按串行顺序传输；已完成文件保留，当前失败文件从头重传；不做字节级续传。
- **REQ-006**: 如果直连失败，系统应在短暂尝试后自动切到中继；只有直连和中继都失败时才进入连接失败态。
- **REQ-007**: 原接收方可在同一 claimed session 内有限次重试；超过预算后回到“请发送方重新创建会话”。
- **REQ-008**: 原接收方可主动放弃 claim；放弃后会话回到 pre-claim 状态，允许新的接收方 claim。
- **REQ-009**: `Completed Session` 仅在整个 manifest 成功接收且内部完整性校验通过后成立。
- **REQ-010**: 非原接收方打开已完成会话时，只能看到 `Completion Notice`，不可再次接收。

## 4. Technical plan

### 4.0 Selected stack
- **TS-001**: Runtime / package manager / unit test runner: **Bun 1.x**。
- **TS-002**: Frontend: **React 19 + TypeScript + Vite + React Router v7**。
- **TS-003**: Styling: **Tailwind CSS 4**。
- **TS-004**: Signaling service: **Hono on Bun**，使用 Bun-compatible HTTP/WebSocket path。
- **TS-005**: Shared schema validation: **Zod 4**。
- **TS-006**: Live session state store: **Redis**。
- **TS-007**: Browser E2E: **Playwright**。

### 4.1 System shape
- **TP-001**: 前端为 React + Vite Web 应用；后端为 Bun runtime 上的轻量信令服务；文件内容默认不经业务服务器。
- **TP-002**: 传输层采用 WebRTC DataChannel；连接协商依赖 signaling；网络穿透使用 STUN/TURN。
- **TP-003**: 信令 API 与 WebSocket 通道使用 Hono on Bun 实现，消息结构由共享 Zod schema 约束。
- **TP-004**: TURN 在第一版默认可用，符合 `Open Relay Policy`；但 UI 必须把 relay 明确标为中继传输。
- **TP-005**: Redis 保存 live session 所需的短期状态，不保存文件内容，不建设历史资产能力。

### 4.2 Session/state model
- **TP-006**: 会话核心状态至少包含：waiting / viewing / claimed / connecting / transferring / completed-view / ended / failed。
- **TP-007**: `Frozen Manifest` 在会话创建后不可修改；发送方如需改文件，必须结束当前会话并重新创建。
- **TP-008**: `Receiver Token` 是原接收方重进凭证；token 丢失后按新访客处理。
- **TP-009**: `Completed Session View` 为短暂结果态，面向 sender 与 original receiver；sender 离线恢复不在 v1 内。

### 4.3 UI/UX rules
- **TP-010**: 首页为发送 / 接收双主入口，发送更突出；接收区以粘贴 `Share Link` 为主，以 `Access Code` 为辅。
- **TP-011**: sender 侧默认展示 `Frozen Manifest` 摘要、会话状态、当前文件进度、整体进度、速度、最终传输模式。
- **TP-012**: receiver 侧流程为：查看 manifest → claim → 建连 → 串行传输 → 完成态/失败态。
- **TP-013**: social preview 必须保持通用，不暴露 manifest 详情；share surface 不可索引。

## 5. Acceptance criteria

- **AC-001**: sender 选择多个文件并创建会话后，receiver 能通过 share link 看到完整 manifest 元数据并执行整体接收。
- **AC-002**: 两个访客同时查看同一链接时，先 claim 的访客获得会话；后 claim 的访客收到占用提示。
- **AC-003**: 直连失败时，系统无需用户二次确认即可自动尝试中继，并在 UI 上显示从直连到中继的模式变化。
- **AC-004**: 多文件传输中断后重进时，已完成文件不重传；未完成文件按文件级从头继续。
- **AC-005**: 会话完成后，原接收方可在短暂窗口内查看只读完成态；其他访客只能看到完成提示。
- **AC-006**: sender 刷新/离开页面后，当前 live session 结束，receiver 不会误以为可继续下载。

## 6. Validation plan

- **VAL-001**: 验证单文件与多文件 happy path：sender 创建会话，receiver 接收成功，进入 `Completed Session View`。
- **VAL-002**: 验证并发 claim：两个 receiver 同时尝试 claim，仅一方成功。
- **VAL-003**: 验证网络模式切换：模拟直连失败并确认系统进入 relay，且 UI 披露正确。
- **VAL-004**: 验证会话中断恢复：多文件传输中断后，已完成文件不重传，失败文件重传。
- **VAL-005**: 验证 sender 离线终止：sender 关闭页面后 receiver 进入结束态并得到重建指引。
- **Validation commands**: TBD - infer from project manifests during mission

## 7. Impact areas

- **UI**: React 19 + React Router v7 页面与 sender/receiver 会话界面。
- **API**: Hono on Bun 的 session creation、claim、signal exchange、access-code resolve、session status、retry/release support。
- **Runtime**: WebRTC peer manager、DataChannel transfer pipeline、relay fallback handling、Bun HTTP/WebSocket server path。
- **State**: Redis live session state、receiver token handling、completed-view window handling。
- **Config**: STUN/TURN、signaling endpoint、share-surface metadata policy、Bun runtime config。
- **Tests**: Bun test for unit/integration, Playwright for browser E2E, direct-vs-relay disclosure checks。
- **Docs**: `CONTEXT.md`, `docs/mvp-product-rules.md`, `AGENTS.md`, implementation-facing architecture notes if needed。

## 8. Agent Execution Contract

- **AEC-001**: Preserve the glossary in `CONTEXT.md`; do not invent parallel vocabulary for the same concepts.
- **AEC-002**: Keep file transfer browser-first; do not introduce upload-to-cloud fallback.
- **AEC-003**: Treat `Share Link` as a bearer credential; avoid rich preview leakage and public indexing.
- **AEC-004**: Do not silently degrade direct vs relay reporting; mode disclosure is a product requirement.
- **AEC-005**: Keep v1 scope tight: no folders, no partial receive, no sender reattach, no PWA-first detour.

## 9. Mission handoff

- **Slice-1**: Scaffold sender/receiver routes, session creation, manifest rendering, share entry surfaces.
- **Slice-2**: Implement signaling + WebRTC peer establishment + direct/relay mode disclosure.
- **Slice-3**: Implement serial multi-file transfer, progress UI, integrity-gated completion.
- **Slice-4**: Implement claim conflict, retry budget, claim release, completed-view window, end/failure states.
- **Completion criteria**: Browser-to-browser live transfer works end-to-end with share link flow, correct state transitions, and verified direct/relay disclosure.

## 10. Assumptions and risks

- **ASSUME-001**: Repo 尚未包含应用代码；mission 首步需按 `AGENTS.md` 选定栈进行 scaffold。
- **ASSUME-002**: `Completed Session View` short-lived window duration remains a product parameter to set during implementation.
- **RISK-001**: `Open Relay Policy` improves success rate but creates relay cost exposure.
- **RISK-002**: Mobile receive is in scope, but practical file size remains environment-dependent.
- **RISK-003**: Browser capability differences may require multiple save-path strategies while preserving one shared product model.
