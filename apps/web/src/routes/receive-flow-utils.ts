import type { ClaimSessionResponse, SessionPublicView } from "../lib/api";
import type { ReceivedFile, TransferProgress } from "../lib/transfer";

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
  | "failed";

export function initialProgress(
  session: SessionPublicView | null,
  completedFiles = 0,
): TransferProgress {
  const files = session?.files ?? [];
  const boundedCompletedFiles = Math.max(0, Math.min(completedFiles, files.length));
  const completedBytes = files
    .slice(0, boundedCompletedFiles)
    .reduce((sum, file) => sum + file.size, 0);
  const nextFile = files[boundedCompletedFiles] ?? null;

  return {
    fileId: nextFile?.id ?? null,
    fileName: nextFile?.name ?? null,
    fileBytes: 0,
    fileTotalBytes: nextFile?.size ?? 0,
    completedBytes,
    totalBytes: session?.totalBytes ?? 0,
    completedFiles: boundedCompletedFiles,
    totalFiles: files.length,
  };
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
      return decodeURIComponent(route[1]);
    }
  } catch {
    // Plain access code or session id.
  }

  const route = trimmed.match(/^\/?(?:f|s)\/([^/]+)$/);
  if (route?.[1]) {
    return decodeURIComponent(route[1]);
  }

  return trimmed;
}

export function receiverStageFromClaim(response: ClaimSessionResponse): ReceiverStage {
  const claim = response.claim;
  if (claim === "occupied") {
    return "occupied";
  }

  if (claim === "completed") {
    return response.originalReceiver ? "completed" : "completion-notice";
  }

  if (claim === "ended") {
    return "ended";
  }

  return "connecting";
}

export function receiverStageFromSession(session: SessionPublicView): ReceiverStage {
  if (session.status === "ended") {
    return "ended";
  }

  if (session.status === "completed-view") {
    return "completion-notice";
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
