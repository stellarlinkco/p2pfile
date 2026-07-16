import type { FileManifestItem } from "@p2pfile/shared";

export type OpfsWorkerFailureCode =
  | "unsupported"
  | "locked"
  | "quota"
  | "write"
  | "flush"
  | "invalid"
  | "worker";

export type OpfsWorkerCommand =
  | {
      type: "open";
      requestId: number;
      generation: number;
      sessionId: string;
      file: FileManifestItem;
    }
  | {
      type: "restore";
      requestId: number;
      generation: number;
      fileId: string;
      durableBytes: number;
    }
  | {
      type: "write";
      requestId: number;
      generation: number;
      fileId: string;
      chunkIndex: number;
      offset: number;
      bytes: ArrayBuffer;
    }
  | {
      type: "flush";
      requestId: number;
      generation: number;
      fileId: string;
      reason: "bytes" | "timer" | "eof";
    }
  | {
      type: "finalize";
      requestId: number;
      generation: number;
      fileId: string;
    }
  | {
      type: "reset";
      requestId: number;
      generation: number;
      fileId?: string;
    };

export type OpfsWorkerSuccess =
  | {
      type: "opened";
      requestId: number;
      generation: number;
      fileId: string;
      processedBytes: number;
      durableBytes: number;
    }
  | {
      type: "restored" | "written" | "flushed";
      requestId: number;
      generation: number;
      fileId: string;
      processedBytes: number;
      durableBytes: number;
    }
  | {
      type: "finalized";
      requestId: number;
      generation: number;
      fileId: string;
      bytes: number;
      durableBytes: number;
      digest: string;
      blob: Blob;
    }
  | {
      type: "reset";
      requestId: number;
      generation: number;
      fileId: string | null;
    };

export type OpfsWorkerFailure = {
  type: "error";
  requestId: number;
  generation: number;
  fileId: string | null;
  code: OpfsWorkerFailureCode;
  message: string;
};

export type OpfsWorkerResponse = OpfsWorkerSuccess | OpfsWorkerFailure;

export function opfsPartName(sessionId: string, file: FileManifestItem) {
  return `p2pfile-${sessionId}-${file.id}-${file.size}.part`;
}

/**
 * Map OPFS worker failures to stable codes used by the main-thread client.
 * Chromium concurrent SyncAccessHandle access surfaces as InvalidStateError
 * with the "state cached in an interface object" message.
 */
export function classifyOpfsWorkerFailure(error: unknown): OpfsWorkerFailureCode {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return "quota";
    if (error.name === "NoModificationAllowedError") return "locked";
    if (error.name === "NotSupportedError") return "unsupported";
    if (
      error.name === "InvalidStateError" &&
      error.message.includes("state cached in an interface object")
    ) {
      return "locked";
    }
  }
  if (error instanceof Error) {
    if (error.message.includes("could not be restored")) return "invalid";
    if (error.message.includes("state cached in an interface object")) return "locked";
    if (error.message.includes("flush")) return "flush";
    if (error.message.includes("write") || error.message.includes("chunk")) return "write";
    if (error.message.includes("invalid") || error.message.includes("incomplete")) return "invalid";
  }
  return "worker";
}

/**
 * Build the exclusive promise chain used by the OPFS worker. Each command waits
 * for the previous one so FileSystemSyncAccessHandle ops never overlap.
 */
export function enqueueExclusiveCommand(
  previous: Promise<void>,
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  return previous
    .catch(() => undefined)
    .then(run)
    .catch((error) => {
      onError(error);
    });
}
