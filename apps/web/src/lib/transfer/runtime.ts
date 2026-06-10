import type { FileManifestItem } from "@p2pfile/shared";
import { startReceiverRuntime as startDirectReceiverRuntime } from "./receiver-runtime";

export {
  applyMode,
  awaitBufferedAmount,
  awaitIceComplete,
  awaitSocketOpen,
  buildReceiverState,
  handleProtocolMessage,
  makePeerConnection,
  parseProtocolMessage,
  parseSignalMessage,
  preferRelayInTests,
  relayAvailable,
  sendProtocolMessage,
  sendSignal,
} from "./runtime-shared";

import { preferRelayInTests } from "./runtime-shared";
import { startSenderRuntime as startDirectSenderRuntime } from "./sender-runtime";
import {
  startReceiverTestFallbackRuntime,
  startSenderTestFallbackRuntime,
} from "./test-fallback-runtime";
import type {
  ReceivedFile,
  ReceiverRuntime,
  ReceiverRuntimeHandlers,
  SenderRuntime,
  SenderRuntimeHandlers,
} from "./types";

export function startSenderRuntime(
  sessionId: string,
  senderToken: string,
  files: File[],
  manifest: FileManifestItem[],
  handlers: SenderRuntimeHandlers,
): Promise<SenderRuntime> {
  if (preferRelayInTests()) {
    return startSenderTestFallbackRuntime(sessionId, senderToken, files, manifest, handlers);
  }

  return startDirectSenderRuntime(sessionId, senderToken, files, manifest, handlers);
}

export function startReceiverRuntime(
  sessionId: string,
  receiverToken: string,
  expectedManifest: FileManifestItem[],
  handlers: ReceiverRuntimeHandlers,
  receivedFiles: ReceivedFile[] = [],
): Promise<ReceiverRuntime> {
  if (preferRelayInTests()) {
    return startReceiverTestFallbackRuntime(
      sessionId,
      receiverToken,
      expectedManifest,
      handlers,
      receivedFiles,
    );
  }

  return startDirectReceiverRuntime(
    sessionId,
    receiverToken,
    expectedManifest,
    handlers,
    receivedFiles,
  );
}

export type {
  BrowserSignalMessage,
  ForwardedSignalMessage,
  ReceivedFile,
  ReceiverRuntime,
  ReceiverRuntimeHandlers,
  SenderRuntime,
  SenderRuntimeHandlers,
  TransferProgress,
  TransferProtocolMessage,
} from "./types";
