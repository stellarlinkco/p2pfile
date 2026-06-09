import type { FileManifestItem, TransferMode } from "@p2pfile/shared";
import type { SessionPublicView } from "../lib/api";
import {
  formatBytes,
  formatMode,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
} from "../lib/format";
import type { TransferProgress } from "../lib/transfer";

const panelClass = "rounded-xl border border-neutral-200 bg-white p-5 shadow-sm";

export function StatCard({ label, value, tone = "default" }: StatCardProps) {
  return (
    <div
      className={[
        "rounded-xl border p-4 text-center",
        tone === "accent" ? "border-teal-200 bg-teal-50" : "border-neutral-200 bg-white",
      ].join(" ")}
    >
      <p className="text-neutral-500 text-sm">{label}</p>
      <p className="mt-1 font-bold text-2xl text-neutral-950 tracking-tight">{value}</p>
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
          <p className="text-neutral-500 text-sm">传输速度</p>
          <p className="mt-1 font-bold text-2xl tabular-nums">{formatSpeed(speed)}</p>
        </div>
        <div className="p-4">
          <p className="text-neutral-500 text-sm">已完成</p>
          <p className="mt-1 font-bold text-2xl tabular-nums">
            {progress.completedFiles} / {progress.totalFiles} completed
          </p>
        </div>
      </div>
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

export function ManifestPanel({ files, totalBytes, title, caption }: ManifestPanelProps) {
  return (
    <section className={panelClass}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="font-bold text-2xl tracking-tight">✣ {title}</h3>
          <p className="mt-1 text-neutral-500 text-sm">{caption}</p>
        </div>
        <span className="rounded-full border border-neutral-200 px-3 py-2 font-semibold text-sm">
          {formatBytes(totalBytes)}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="grid grid-cols-[48px_minmax(0,1.5fr)_1fr_96px_110px] bg-neutral-50 px-3 py-3 text-neutral-500 text-sm">
          <span>#</span>
          <span>文件名</span>
          <span>备注</span>
          <span>大小</span>
          <span>状态</span>
        </div>
        {files.map((file, index) => (
          <div
            className="grid grid-cols-[48px_minmax(0,1.5fr)_1fr_96px_110px] items-center border-neutral-200 border-t px-3 py-4 text-sm"
            key={file.id}
          >
            <span className="font-semibold">{index + 1}</span>
            <span className="truncate font-semibold text-neutral-950">{file.name}</span>
            <span>metadata-only</span>
            <span className="tabular-nums">{formatBytes(file.size)}</span>
            <span className="w-fit rounded-full bg-teal-50 px-3 py-1 font-medium text-teal-700">
              ● {index === 0 ? "ready" : index === 1 ? "sending" : "queued"}
            </span>
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
};

export function ModeDisclosure({ mode, status }: { mode: TransferMode | null; status: string }) {
  const formattedMode = formatMode(mode);
  return (
    <section className={panelClass} data-testid="mode-disclosure">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="font-bold text-lg">Transfer Mode</h3>
        <span className="rounded-full bg-teal-50 px-3 py-1 font-medium text-sm text-teal-700">
          {formattedMode}
        </span>
      </div>
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
        <p className="font-semibold">Direct Transfer 优先；Relayed Transfer 仅在需要时自动使用。</p>
        <p className="mt-2 text-neutral-600 text-sm">
          当前版本不提供手动切换按钮。这里用于披露实际传输模式，避免用户误以为文件会先上传到云端。
        </p>
      </div>
      <p className="mt-3 text-neutral-600 text-sm">
        {formattedMode} · {status}
      </p>
    </section>
  );
}

export function SessionSummary({ session }: { session: SessionPublicView }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Session ID" value={session.sessionId} />
      <StatCard label="Access Code" value={session.accessCode || "--"} tone="accent" />
      <StatCard label="Expires" value={formatRelativeTime(session.expiresAt)} />
      <StatCard label="Status" value={session.status} />
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
