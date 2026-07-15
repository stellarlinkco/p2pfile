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
