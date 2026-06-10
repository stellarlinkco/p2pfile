import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatBytes } from "../lib/format";
import type { TransferProgress } from "../lib/transfer";
import type { SenderFlowState, SenderShareState } from "./home-flow";

const SENDER_STAGE_LABELS: Record<SenderFlowState["stage"], string> = {
  completed: "已完成",
  creating: "创建中",
  ended: "已结束",
  failed: "失败",
  idle: "待创建",
  transferring: "传输中 ●",
  waiting: "等待接收方",
};

export function SenderPanel({ sender }: { sender: SenderFlowState }) {
  const stageLabel = SENDER_STAGE_LABELS[sender.stage];

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="font-bold text-2xl tracking-tight">发送文件</h1>
        <span className="font-semibold text-teal-700 text-sm">{stageLabel}</span>
      </div>
      <label className="grid min-h-24 cursor-pointer grid-cols-[1fr_auto] items-center gap-4 rounded-xl border border-dashed border-neutral-300 p-5 transition hover:border-teal-600/50">
        <span className="flex items-center justify-center gap-3 text-neutral-700">
          <span className="text-3xl text-teal-700">▧</span>
          点击右侧按钮选择一个或多个文件
        </span>
        <span className="rounded-lg bg-teal-600 px-6 py-3 font-bold text-white shadow-sm">
          选择文件
        </span>
        <input
          className="sr-only"
          data-testid="sender-file-input"
          multiple
          onChange={(event) => sender.setSelectedFiles(Array.from(event.target.files ?? []))}
          type="file"
        />
      </label>
      <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-xl border border-neutral-200 text-center">
        <StatCell label="已选文件" value={`${sender.selectedFiles.length}`} />
        <StatCell label="总大小" value={formatBytes(sender.totalBytes)} />
        <StatCell label="发送状态" value={stageLabel} accent />
      </div>
      <button
        className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 font-bold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-500"
        data-testid="create-session-button"
        disabled={sender.selectedFiles.length === 0 || sender.stage === "creating"}
        onClick={sender.createCurrentSession}
        type="button"
      >
        ▷ {sender.stage === "creating" ? "创建中…" : "创建会话"}
      </button>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {sender.shareState ? (
          <button
            className="rounded-xl border border-neutral-200 px-3 py-3"
            onClick={sender.endCurrentSession}
            type="button"
          >
            □ 结束会话
          </button>
        ) : null}
        <Link
          className="rounded-xl border border-neutral-200 px-3 py-3 text-center"
          data-testid="home-receive-link"
          to="/receive"
        >
          ◉ 查看接收页
        </Link>
      </div>
      <p className="mt-3 text-neutral-500 text-sm" data-testid="session-status">
        {sender.status}
      </p>
      {sender.error ? <p className="mt-2 text-rose-700 text-sm">{sender.error}</p> : null}
    </section>
  );
}

function StatCell({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="border-neutral-200 border-r p-3 last:border-r-0">
      <p className="text-neutral-500 text-sm">{label}</p>
      <p
        className={["mt-1 font-bold text-xl", accent ? "text-teal-700" : "text-neutral-950"].join(
          " ",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function ShareSurfaces({
  sender,
  progress,
}: {
  sender: SenderShareState;
  progress: TransferProgress;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(sender.shareUrl);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <h2 className="font-bold text-xl tracking-tight">入口和接收状态并排，不再藏到下方</h2>
        <div className="grid gap-1 justify-items-end">
          <button
            className="rounded-lg bg-teal-600 px-5 py-3 font-bold text-white"
            onClick={copyShareLink}
            type="button"
          >
            复制 Share Link
          </button>
          {copyStatus === "copied" ? (
            <span className="font-medium text-emerald-700 text-sm" role="status">
              已复制
            </span>
          ) : null}
          {copyStatus === "failed" ? (
            <span className="font-medium text-rose-700 text-sm" role="status">
              复制失败，请手动复制
            </span>
          ) : null}
        </div>
      </div>
      <ShareLinkValue label="Share Link" testId="share-link" value={sender.shareUrl} />
      <div className="mt-3 grid grid-cols-[1fr_176px] gap-4">
        <ShareValue label="Access Code" testId="access-code" value={sender.session.accessCode} />
        <ShareQrCode shareUrl={sender.shareUrl} />
      </div>
      <p className="mt-3 text-neutral-500 text-sm">
        Completed Files：{progress.completedFiles}/{progress.totalFiles}
      </p>
    </section>
  );
}

export function SharePlaceholder() {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="font-bold text-xl tracking-tight">接收文件</h2>
      <p className="mt-2 text-neutral-500 text-sm">
        接收入口是独立页面。创建会话后，这里会改为显示可复制的 Share Link、Access Code 与 QR Code。
      </p>
      <Link
        className="mt-4 flex min-h-12 items-center justify-center rounded-lg bg-teal-600 font-bold text-white"
        data-testid="home-receive-link"
        to="/receive"
      >
        打开接收页
      </Link>
    </section>
  );
}

function ShareLinkValue({
  label,
  testId,
  value,
}: {
  label: string;
  testId: string;
  value: string;
}) {
  return (
    <div>
      <p className="mb-1 font-semibold text-sm">{label}</p>
      <a
        className="block break-all rounded-lg border border-neutral-200 px-4 py-3"
        data-testid={testId}
        href={value}
        rel="noopener noreferrer"
        target="_blank"
      >
        {value}
      </a>
    </div>
  );
}

function ShareValue({ label, testId, value }: { label: string; testId: string; value: string }) {
  return (
    <div>
      <p className="mb-1 font-semibold text-sm">{label}</p>
      <p
        className="rounded-lg border border-neutral-200 px-4 py-3 font-mono text-2xl tracking-[0.16em]"
        data-testid={testId}
      >
        {value}
      </p>
    </div>
  );
}

function ShareQrCode({ shareUrl }: { shareUrl: string }) {
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    let active = true;

    QRCode.toDataURL(shareUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 148,
    })
      .then((nextDataUrl) => {
        if (active) {
          setDataUrl(nextDataUrl);
        }
      })
      .catch(() => {
        if (active) {
          setDataUrl("");
        }
      });

    return () => {
      active = false;
    };
  }, [shareUrl]);

  return (
    <div
      className="grid h-36 place-items-center rounded-xl border border-neutral-200 bg-white p-2"
      data-testid="qr-code"
    >
      {dataUrl ? (
        <img alt="QR Code for Share Link" className="size-32" src={dataUrl} />
      ) : (
        <span className="text-neutral-500 text-sm">正在生成 QR Code…</span>
      )}
    </div>
  );
}

export function CompletedSenderView() {
  return (
    <section
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-5"
      data-testid="completed-session-view"
    >
      <h3 className="font-bold text-emerald-950 text-lg">Completed Session View</h3>
      <p className="mt-2 text-emerald-900 text-sm">
        整个 Frozen Manifest 已发送完成。该结果态只读且短暂保留。
      </p>
    </section>
  );
}

export function EndedSenderView() {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
      <h3 className="font-bold text-amber-950 text-lg">Sender-Ended Session</h3>
      <p className="mt-2 text-amber-900 text-sm">
        当前会话已结束。若要重新发送，请重新选择文件并创建新会话。
      </p>
    </section>
  );
}
