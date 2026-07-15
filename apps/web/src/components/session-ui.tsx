import type { FileManifestItem, TransferMode } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import {
  formatBytes,
  formatMode,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
} from "../lib/format";
import type { TransferFileProgress, TransferProgress, TransportDiagnostics } from "../lib/transfer";

const panelClass = "min-w-0 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm";

export function StatCard({ label, value, tone = "default" }: StatCardProps) {
  return (
    <div
      className={[
        "min-w-0 rounded-xl border p-4 text-center",
        tone === "accent" ? "border-teal-200 bg-teal-50" : "border-neutral-200 bg-white",
      ].join(" ")}
    >
      <p className="text-neutral-500 text-sm">{label}</p>
      <p className="mt-1 break-all font-bold text-xl text-neutral-950 tracking-tight sm:text-2xl">
        {value}
      </p>
    </div>
  );
}

type StatCardProps = {
  label: string;
  value: string;
  tone?: "default" | "accent";
};

export function ProgressPanel({ progress, speed }: ProgressPanelProps) {
  return (
    <section className={panelClass}>
      <ProgressRow
        label={progress.fileName ? `当前文件： ${progress.fileName}` : "当前文件"}
        completed={progress.fileBytes}
        total={progress.fileTotalBytes}
      />
      <ProgressRow
        label={`总体进度（${progress.completedFiles} / ${progress.totalFiles}）`}
        completed={progress.completedBytes}
        total={progress.totalBytes}
      />
      <div className="mt-5 grid grid-cols-2 rounded-xl border border-neutral-200 bg-neutral-50 text-center">
        <div className="border-neutral-200 border-r p-4">
          <p className="text-neutral-500 text-sm">速度</p>
          <p className="mt-1 font-bold text-xl tabular-nums sm:text-2xl">{formatSpeed(speed)}</p>
        </div>
        <div className="p-4">
          <p className="text-neutral-500 text-sm">已完成</p>
          <p className="mt-1 font-bold text-xl tabular-nums sm:text-2xl">
            {progress.completedFiles} / {progress.totalFiles}
          </p>
        </div>
      </div>
    </section>
  );
}

export function OverallProgressPanel({ progress }: { progress: TransferProgress }) {
  return (
    <section className={panelClass}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold text-xl tracking-tight">总体进度</h2>
          <p className="mt-1 text-neutral-500 text-sm">
            已完成 {progress.completedFiles} / {progress.totalFiles}
          </p>
        </div>
        <span className="font-mono font-semibold text-teal-700 tabular-nums">
          {formatPercent(progress.completedBytes, progress.totalBytes)}
        </span>
      </div>
      <ProgressRow
        label={`${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}`}
        completed={progress.completedBytes}
        total={progress.totalBytes}
      />
    </section>
  );
}

type ProgressPanelProps = {
  progress: TransferProgress;
  speed: number | null;
};

function ProgressRow({ label, completed, total }: ProgressRowProps) {
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.min(100, Math.round((completed / safeTotal) * 100));

  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between gap-4 font-semibold text-sm">
        <span>{label}</span>
        <span className="font-mono text-teal-700 tabular-nums">
          {formatPercent(completed, total)}
        </span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-teal-600 transition-[width] duration-200"
          style={{ width: `${ratio}%` }}
        />
      </div>
    </div>
  );
}

type ProgressRowProps = {
  label: string;
  completed: number;
  total: number;
};

export function ManifestPanel({
  files,
  totalBytes,
  title,
  caption,
  showStatus = true,
  fileProgress,
}: ManifestPanelProps) {
  return (
    <section className={panelClass}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="font-bold text-xl tracking-tight sm:text-2xl">✣ {title}</h3>
          <p className="mt-1 text-neutral-500 text-sm">{caption}</p>
        </div>
        <span className="rounded-full border border-neutral-200 px-3 py-2 font-semibold text-sm">
          {formatBytes(totalBytes)}
        </span>
      </div>
      <div className="max-w-full overflow-x-auto rounded-xl border border-neutral-200">
        <div
          className={[
            "grid min-w-[620px] bg-neutral-50 px-3 py-3 text-neutral-500 text-sm",
            showStatus
              ? "grid-cols-[48px_minmax(0,1.5fr)_1fr_96px_110px]"
              : "grid-cols-[48px_minmax(0,1.5fr)_1fr_96px]",
          ].join(" ")}
        >
          <span>#</span>
          <span>文件名</span>
          <span>备注</span>
          <span>大小</span>
          {showStatus ? <span>状态</span> : null}
        </div>
        {files.map((file, index) => (
          <div
            className={[
              "grid min-w-[620px] items-center border-neutral-200 border-t px-3 py-4 text-sm",
              showStatus
                ? "grid-cols-[48px_minmax(0,1.5fr)_1fr_96px_110px]"
                : "grid-cols-[48px_minmax(0,1.5fr)_1fr_96px]",
            ].join(" ")}
            key={file.id}
          >
            <span className="font-semibold">{index + 1}</span>
            <span className="truncate font-semibold text-neutral-950">{file.name}</span>
            <span>仅元数据</span>
            <span className="tabular-nums">{formatBytes(file.size)}</span>
            {showStatus ? (
              <span
                className="w-fit rounded-full bg-teal-50 px-3 py-1 font-medium text-teal-700"
                data-testid={`file-state-${file.id}`}
              >
                {fileProgress?.find((progress) => progress.fileId === file.id)?.state ?? "queued"}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

type ManifestPanelProps = {
  files: FileManifestItem[];
  totalBytes: number;
  title: string;
  caption: string;
  showStatus?: boolean;
  fileProgress?: TransferFileProgress[];
};

export function ModeDisclosure({
  mode,
  diagnostics = null,
  testId = "mode-disclosure",
}: {
  mode: TransferMode | null;
  diagnostics?: TransportDiagnostics | null;
  testId?: string | null;
}) {
  const formattedMode = formatMode(mode);
  const pathLabel = diagnostics
    ? [
        diagnostics.localCandidateType ?? "unknown",
        "→",
        diagnostics.remoteCandidateType ?? "unknown",
        diagnostics.protocol ? `(${diagnostics.protocol})` : null,
        diagnostics.iceTransportPolicy === "relay" ? "TURN-only" : null,
      ]
        .filter(Boolean)
        .join(" ")
    : null;

  return (
    <section className={panelClass} data-testid={testId ?? undefined}>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="font-bold text-lg">传输方式</h3>
        <span className="rounded-full bg-teal-50 px-3 py-1 font-medium text-sm text-teal-700">
          {formattedMode}
        </span>
      </div>
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
        <p className="font-semibold">优先直连，必要时自动切到中继。</p>
        {pathLabel ? (
          <p className="mt-2 text-neutral-600 text-sm" data-testid="transport-path">
            路径：{pathLabel}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function SessionSummary({ session }: { session: SessionPublicView }) {
  return (
    <section className="grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-4">
      <StatCard label="Session ID" value={session.sessionId} />
      <StatCard label="Access Code" value={session.accessCode || "--"} tone="accent" />
      <div className="hidden xl:block">
        <StatCard label="Expires" value={formatRelativeTime(session.expiresAt)} />
      </div>
      <div className="hidden xl:block">
        <StatCard label="Status" value={session.status} />
      </div>
    </section>
  );
}

export function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded-xl border border-dashed border-neutral-200 bg-white p-5 shadow-sm">
      <h3 className="font-bold text-lg">{title}</h3>
      <p className="mt-2 text-neutral-600 text-sm leading-6">{body}</p>
    </section>
  );
}
