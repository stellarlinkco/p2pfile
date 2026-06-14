import type { ClaimSessionResponse, SessionPublicView } from "../lib/api";
import type { ReceivedFile, TransferFileProgress, TransferProgress } from "../lib/transfer";

export const RETRY_EXHAUSTED_STATUS = "Retry Budget 已用尽：请发送方重新创建会话。";
export const RECONNECTING_STATUS =
  "正在等待发送方重新连接：保留已完成文件，原 Receiver Token 可在同一 Share Link 继续。";

export type ReceiverStage =
  | "entry"
  | "loading"
  | "manifest"
  | "claiming"
  | "occupied"
  | "connecting"
  | "receiving"
  | "completed"
  | "completion-notice"
  | "ended"
  | "reconnecting"
  | "retry-exhausted"
  | "failed";

function fileProgressFromSession(
  session: SessionPublicView | null,
  committedBytesByFileId: ReadonlyMap<string, number>,
) {
  return (session?.files ?? []).map((file) => {
    const committedBytes = Math.max(
      0,
      Math.min(committedBytesByFileId.get(file.id) ?? 0, file.size),
    );
    return {
      fileId: file.id,
      fileName: file.name,
      fileBytes: committedBytes,
      fileTotalBytes: file.size,
      state:
        committedBytes === file.size && (file.size > 0 || committedBytesByFileId.has(file.id))
          ? "completed"
          : committedBytes > 0
            ? "reconnecting"
            : "queued",
    } satisfies TransferFileProgress;
  });
}

export function progressFromCommitted(
  session: SessionPublicView | null,
  committedBytesByFileId: ReadonlyMap<string, number>,
): TransferProgress {
  const files = fileProgressFromSession(session, committedBytesByFileId);
  const nextFile = files.find((file) => file.state !== "completed") ?? null;
  return {
    fileId: nextFile?.fileId ?? null,
    fileName: nextFile?.fileName ?? null,
    fileBytes: nextFile?.fileBytes ?? 0,
    fileTotalBytes: nextFile?.fileTotalBytes ?? 0,
    completedBytes: files.reduce((sum, file) => sum + file.fileBytes, 0),
    totalBytes: session?.totalBytes ?? 0,
    completedFiles: files.filter((file) => file.state === "completed").length,
    totalFiles: files.length,
    files,
  };
}

export function initialProgress(
  session: SessionPublicView | null,
  completedFiles = 0,
): TransferProgress {
  const files = session?.files ?? [];
  const boundedCompletedFiles = Math.max(0, Math.min(completedFiles, files.length));
  return progressFromCommitted(
    session,
    new Map(files.slice(0, boundedCompletedFiles).map((file) => [file.id, file.size])),
  );
}

function decodeEntrySegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function sessionIdFromEntry(input: string) {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    const route = url.pathname.match(/^\/(?:f|s)\/([^/]+)$/);
    if (route?.[1]) {
      return decodeEntrySegment(route[1]);
    }
  } catch {
    // Plain access code or session id.
  }

  const route = trimmed.match(/^\/?(?:f|s)\/([^/]+)$/);
  if (route?.[1]) {
    return decodeEntrySegment(route[1]);
  }

  return trimmed;
}

export function receiverStageFromClaim(response: ClaimSessionResponse): ReceiverStage {
  const claim = response.claim;
  if (claim === "occupied") {
    return "occupied";
  }

  if (claim === "completed") {
    return "completion-notice";
  }

  if (claim === "ended") {
    return "ended";
  }

  if (claim === "failed") {
    return "retry-exhausted";
  }

  if (response.session.status === "reconnecting") {
    return "reconnecting";
  }

  return "connecting";
}

export function receiverStageFromSession(session: SessionPublicView): ReceiverStage {
  if (session.status === "ended") {
    return "ended";
  }

  if (session.status === "failed") {
    return "retry-exhausted";
  }

  if (session.status === "completed-view") {
    return "completion-notice";
  }

  if (session.status === "reconnecting") {
    return "reconnecting";
  }

  return "manifest";
}

export function saveReceivedFile(file: ReceivedFile) {
  const anchor = document.createElement("a");
  anchor.href = file.url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
