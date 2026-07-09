import type { FileManifestItem, ResumeProgress, TransferMode } from "@p2pfile/shared";
import type { SignalRole } from "../api";

export type TransferProtocolMessage =
  | { type: "manifest"; files: FileManifestItem[]; totalBytes: number; manifestHash: string }
  | { type: "file-start"; file: FileManifestItem; offset: number }
  | {
      type: "chunk";
      fileId: string;
      chunkIndex: number;
      offset: number;
      bytes: ArrayBuffer;
      chunkDigest: string;
    }
  | { type: "chunk-commit"; fileId: string; chunkIndex: number; committedBytes: number }
  | { type: "file-end"; fileId: string; bytes: number; digest: string }
  | { type: "complete"; totalBytes: number };

export type RelayProtocolMessage =
  | { type: "manifest"; files: FileManifestItem[]; totalBytes: number; manifestHash: string }
  | { type: "file-start"; file: FileManifestItem; offset: number }
  | {
      type: "chunk";
      fileId: string;
      chunkIndex: number;
      offset: number;
      bytesBase64: string;
      chunkDigest: string;
    }
  | { type: "chunk-commit"; fileId: string; chunkIndex: number; committedBytes: number }
  | { type: "file-end"; fileId: string; bytes: number; digest: string }
  | { type: "complete"; totalBytes: number };

export type TransferFileState = "queued" | "receiving" | "reconnecting" | "completed" | "failed";

export type TransferFileProgress = {
  fileId: string;
  fileName: string;
  fileBytes: number;
  fileTotalBytes: number;
  state: TransferFileState;
};

export type TransferProgress = {
  fileId: string | null;
  fileName: string | null;
  fileBytes: number;
  fileTotalBytes: number;
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  files?: TransferFileProgress[];
};

export type TransportDiagnostics = {
  mode: "direct" | "relay";
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  protocol: string | null;
  iceTransportPolicy: "all" | "relay" | null;
};

export type SenderRuntimeHandlers = {
  onStatus: (status: string) => void;
  onMode: (mode: TransferMode) => void;
  onProgress: (progress: TransferProgress) => void;
  onComplete: () => void;
  onError: (message: string) => void;
  onTransportDiagnostics?: (diagnostics: TransportDiagnostics) => void;
};

export type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  url: string;
};

export type ReceiverRuntimeHandlers = SenderRuntimeHandlers & {
  onFileReceived: (file: ReceivedFile) => void | Promise<void>;
  onEnded: () => void;
};

export type BrowserSignalMessage =
  | { type: "offer"; payload: RTCSessionDescriptionInit }
  | { type: "answer"; payload: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; payload: RTCIceCandidateInit }
  | { type: "mode"; payload: { mode: TransferMode } }
  | {
      type: "receiver-ready";
      payload: { progress: ResumeProgress; completedFiles?: number; receiverInstanceId?: string };
    }
  | { type: "relay-ready"; payload: Record<string, never> }
  | { type: "relay-message"; payload: { sequence: number; message: RelayProtocolMessage } }
  | { type: "relay-ack"; payload: { sequence: number } }
  | { type: "transfer-complete"; payload: { completedAt?: number } }
  | { type: "sender-reconnecting"; payload: { reason?: string } }
  | { type: "sender-left"; payload: Record<string, never> };

export type ForwardedSignalMessage = BrowserSignalMessage & {
  from?: SignalRole;
};

export type SenderRuntime = {
  stop: () => void;
  markSenderLeft: () => void;
};

export type ReceiverRuntime = {
  stop: () => void;
  release: () => void;
};
