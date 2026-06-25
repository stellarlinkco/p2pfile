import { Link } from "react-router-dom";
import {
  EmptyHint,
  ManifestPanel,
  ModeDisclosure,
  ProgressPanel,
  SessionSummary,
} from "../components/session-ui";
import type { ReceiveFlowState } from "./receive-flow-types";
import { shouldShowReconnectingNotice } from "./receive-flow-utils";

type ReceivePageViewProps = { flow: ReceiveFlowState };

export function ReceivePageView({ flow }: ReceivePageViewProps) {
  const hideLivePanels =
    flow.stage === "occupied" ||
    flow.stage === "completion-notice" ||
    flow.stage === "retry-exhausted" ||
    flow.stage === "ended";
  const openEntryDisabled =
    flow.stage === "loading" ||
    flow.stage === "claiming" ||
    flow.stage === "connecting" ||
    flow.stage === "receiving";

  return (
    <div className="mx-auto grid w-full max-w-[1568px] gap-3 px-3 py-3 sm:px-4 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="grid min-w-0 grid-cols-1 content-start gap-3">
        <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-neutral-500 text-sm">接收入口</p>
              <h1 className="mt-1 font-bold text-2xl tracking-tight">接收文件</h1>
            </div>
            <span className="rounded-full bg-teal-50 px-3 py-2 font-medium text-teal-700 text-sm">
              临时会话
            </span>
          </div>
          <p className="mb-4 text-neutral-600 text-sm leading-6">
            粘贴链接或访问码后查看文件清单，再开始接收。
          </p>
          <label className="font-semibold text-sm" htmlFor="receiver-entry">
            链接或访问码
          </label>
          <input
            className="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 outline-none focus:border-teal-600"
            data-testid="receiver-entry-input"
            id="receiver-entry"
            onChange={(event) => flow.setEntryValue(event.target.value)}
            placeholder="https://…/f/session-id 或访问码"
            value={flow.entryValue}
          />
          <button
            className="mt-3 flex min-h-12 w-full items-center justify-center rounded-lg bg-teal-600 font-bold text-white disabled:bg-neutral-200 disabled:text-neutral-500"
            data-testid="receiver-open-session-button"
            disabled={openEntryDisabled}
            onClick={flow.openEntry}
            type="button"
          >
            打开
          </button>
          <div className="mt-3 text-neutral-600 text-sm" data-testid="session-status">
            {flow.status}
          </div>
          {flow.error ? <p className="mt-2 text-rose-700 text-sm">{flow.error}</p> : null}
        </section>
        {hideLivePanels ? null : <ModeDisclosure mode={flow.mode} />}
        {hideLivePanels ? null : <ProgressPanel progress={flow.progress} speed={flow.speed} />}
        <div data-testid="current-file-progress" className="hidden" />
        <div data-testid="overall-progress" className="hidden" />
      </section>

      <section className="grid min-w-0 grid-cols-1 content-start gap-3">
        {flow.session && !hideLivePanels ? (
          <>
            <SessionSummary session={flow.session} />
            <div data-testid="receiver-manifest">
              <ManifestPanel
                caption="接收前只显示文件名和大小。"
                fileProgress={flow.progress.files}
                files={flow.session.files}
                title="文件清单"
                totalBytes={flow.session.totalBytes}
              />
            </div>
          </>
        ) : hideLivePanels ? null : (
          <EmptyHint title="等待会话入口" body="输入链接或访问码后查看文件清单。" />
        )}

        {flow.stage === "manifest" || flow.stage === "failed" || flow.stage === "reconnecting" ? (
          <>
            <button
              className="min-h-12 w-full rounded-lg bg-teal-600 px-4 font-bold text-white disabled:bg-neutral-200 disabled:text-neutral-500"
              data-testid="claim-session-button"
              disabled={!flow.session}
              onClick={flow.claimCurrentSession}
              type="button"
            >
              接收全部文件
            </button>
            {flow.retriesRemaining !== null ? (
              <p className="text-neutral-600 text-sm" data-testid="retry-budget-remaining">
                还可重试 {flow.retriesRemaining} 次，用尽后需重新创建会话。
              </p>
            ) : null}
          </>
        ) : null}

        {flow.stage === "claiming" || flow.stage === "connecting" || flow.stage === "receiving" ? (
          <button
            className="min-h-12 w-full rounded-lg border border-neutral-200 px-4 font-medium"
            onClick={flow.releaseCurrentClaim}
            type="button"
          >
            放弃接收
          </button>
        ) : null}

        {flow.stage === "occupied" ? <OccupiedNotice /> : null}
        {shouldShowReconnectingNotice(flow.session, flow.stage) ? <ReconnectingNotice /> : null}
        {flow.stage === "retry-exhausted" ? <RetryExhaustedNotice /> : null}
        {flow.stage === "ended" ? <EndedNotice /> : null}
        {flow.stage === "completion-notice" ? <CompletionNotice /> : null}
        {flow.stage === "completed" ? <CompletedReceiverView flow={flow} /> : null}
      </section>
    </div>
  );
}

function NoticeCard({ title, body, testId, tone }: NoticeCardProps) {
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    neutral: "border-neutral-200 bg-white text-neutral-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
  }[tone];
  return (
    <section
      className={["rounded-xl border p-5 shadow-sm", toneClass].join(" ")}
      data-testid={testId}
    >
      <h3 className="font-bold text-lg">{title}</h3>
      <p className="mt-2 text-sm leading-6 opacity-80">{body}</p>
    </section>
  );
}

type NoticeCardProps = {
  title: string;
  body: string;
  testId: string;
  tone: "amber" | "rose" | "neutral" | "emerald";
};

function OccupiedNotice() {
  return (
    <NoticeCard
      body="另一个接收方已 claim 当前 Temporary Session Window。请让发送方重新创建会话。"
      testId="occupied-session-notice"
      title="Occupied Session Notice"
      tone="amber"
    />
  );
}

function ReconnectingNotice() {
  return (
    <NoticeCard
      body="发送方连接意外中断。请保持当前 Share Link；原 Receiver Token 可继续接收，已完成文件会保留，当前未完成文件会从文件边界重启。"
      testId="reconnecting-session-notice"
      title="Waiting for peer reconnect"
      tone="amber"
    />
  );
}
function RetryExhaustedNotice() {
  return (
    <NoticeCard
      body="同一 Claimed Session 内的重试次数已用尽，该会话已进入失败态。请发送方重新创建会话。"
      testId="retry-exhausted-notice"
      title="Retry Budget 已用尽"
      tone="rose"
    />
  );
}

function EndedNotice() {
  return (
    <NoticeCard
      body="发送方已结束或离开当前会话。请请求发送方重新创建会话。"
      testId="ended-session-notice"
      title="Sender-Ended Session"
      tone="rose"
    />
  );
}

function CompletionNotice() {
  return (
    <NoticeCard
      body="该会话已完成。只有原接收方可在短暂窗口内查看 Completed Session View；如需重新接收，请让发送方重新创建会话。"
      testId="completion-notice"
      title="Completion Notice"
      tone="neutral"
    />
  );
}

function CompletedReceiverView({ flow }: { flow: ReceiveFlowState }) {
  return (
    <section
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm"
      data-testid="completed-session-view"
    >
      <h3 className="font-bold text-emerald-950 text-lg">Completed Session View</h3>
      <p className="mt-2 text-emerald-900 text-sm leading-6">
        整个 File Manifest 已接收完成并通过 v1 字节数校验。该结果态只读且短暂保留。
      </p>
      {flow.receivedFiles.length > 0 ? (
        <ul className="mt-4 grid gap-2">
          {flow.receivedFiles.map((file) => (
            <li
              className="flex items-center justify-between rounded-lg border border-emerald-200 bg-white px-4 py-3"
              key={file.id}
            >
              <span className="truncate font-medium text-sm">{file.name}</span>
              <button
                className="rounded-lg border border-emerald-300 px-3 py-2 text-sm"
                aria-label={`保存 ${file.name}`}
                onClick={() => {
                  const anchor = document.createElement("a");
                  anchor.href = file.url;
                  anchor.download = file.name;
                  document.body.append(anchor);
                  anchor.click();
                  anchor.remove();
                }}
                type="button"
              >
                保存
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Link
        className="mt-4 inline-flex rounded-lg border border-emerald-300 px-3 py-2 text-sm"
        to="/receive"
      >
        接收其他会话
      </Link>
    </section>
  );
}
