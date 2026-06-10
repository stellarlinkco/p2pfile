import type { FileManifestItem, TransferMode } from "@p2pfile/shared";
import type { SignalRole } from "../api";

export type TransferProtocolMessage =
  | { type: "manifest"; files: FileManifestItem[]; totalBytes: number }
  | { type: "file-start"; file: FileManifestItem }
  | { type: "chunk"; fileId: string; bytes: ArrayBuffer }
  | { type: "file-end"; fileId: string; bytes: number; digest: string }
  | { type: "complete"; totalBytes: number };

export type RelayProtocolMessage =
  | { type: "manifest"; files: FileManifestItem[]; totalBytes: number }
  | { type: "file-start"; file: FileManifestItem }
  | { type: "chunk"; fileId: string; bytesBase64: string }
  | { type: "file-end"; fileId: string; bytes: number; digest: string }
  | { type: "complete"; totalBytes: number };

export type TransferProgress = {
  fileId: string | null;
  fileName: string | null;
  fileBytes: number;
  fileTotalBytes: number;
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
};

export type SenderRuntimeHandlers = {
  onStatus: (status: string) => void;
  onMode: (mode: TransferMode) => void;
  onProgress: (progress: TransferProgress) => void;
  onComplete: () => void;
  onError: (message: string) => void;
};

export type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  url: string;
};

export type ReceiverRuntimeHandlers = SenderRuntimeHandlers & {
  onFileReceived: (file: ReceivedFile) => void;
  onEnded: () => void;
};

export type BrowserSignalMessage =
  | { type: "offer"; payload: RTCSessionDescriptionInit }
  | { type: "answer"; payload: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; payload: RTCIceCandidateInit }
  | { type: "mode"; payload: { mode: TransferMode } }
  | { type: "receiver-ready"; payload: { completedFiles: number } }
  | { type: "relay-ready"; payload: Record<string, never> }
  | { type: "relay-message"; payload: { sequence: number; message: RelayProtocolMessage } }
  | { type: "relay-ack"; payload: { sequence: number } }
  | { type: "transfer-complete"; payload: { completedAt?: number } }
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
