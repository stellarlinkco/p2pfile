import type { FileManifestItem } from "@p2pfile/shared";
import { getSignalUrl } from "../api";
import { fromRelayMessage } from "./relay-runtime";
import {
  applyMode,
  awaitIceComplete,
  awaitSocketOpen,
  buildReceiverState,
  handleProtocolMessage,
  makePeerConnection,
  parseProtocolMessage,
  parseSignalMessage,
  preferRelayInTests,
  relayAvailable,
  sendSignal,
} from "./runtime-shared";
import type {
  ReceivedFile,
  ReceiverRuntime,
  ReceiverRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

function restoreProgressState(
  expectedManifest: FileManifestItem[],
  receivedFiles: ReceivedFile[],
  handlers: ReceiverRuntimeHandlers,
) {
  const completedIds = new Set(receivedFiles.map((file) => file.id));
  let completedBytes = 0;
  for (const file of expectedManifest) {
    if (!completedIds.has(file.id)) {
      break;
    }
    completedBytes += file.size;
  }

  const nextFile = expectedManifest[receivedFiles.length] ?? null;
  handlers.onProgress({
    fileId: nextFile?.id ?? null,
    fileName: nextFile?.name ?? null,
    fileBytes: 0,
    fileTotalBytes: nextFile?.size ?? 0,
    completedBytes,
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedFiles: receivedFiles.length,
    totalFiles: expectedManifest.length,
  });
}

export async function startReceiverRuntime(
  sessionId: string,
  receiverToken: string,
  expectedManifest: FileManifestItem[],
  handlers: ReceiverRuntimeHandlers,
  receivedFiles: ReceivedFile[] = [],
): Promise<ReceiverRuntime> {
  const ws = new WebSocket(getSignalUrl(sessionId, "receiver", receiverToken));
  const pc = makePeerConnection(ws, handlers, "Connecting");
  const state = buildReceiverState(expectedManifest);
  const pendingRelayMessages = new Map<number, TransferProtocolMessage>();
  let nextRelaySequence = 0;
  let relayRequested = false;
  let relayAnnounceTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  if (receivedFiles.length > 0) {
    state.receivedFiles = receivedFiles.length;
    state.completedBytes = receivedFiles.reduce((sum, file) => sum + file.size, 0);
    restoreProgressState(expectedManifest, receivedFiles, handlers);
  }

  const announceRelay = () => {
    sendSignal(ws, { type: "mode", payload: { mode: "relay" } });
    sendSignal(ws, { type: "relay-ready", payload: {} });
  };

  const stopRelayAnnouncements = () => {
    if (!relayAnnounceTimer) {
      return;
    }

    clearInterval(relayAnnounceTimer);
    relayAnnounceTimer = null;
  };

  const requestRelay = () => {
    if (stopped || !relayAvailable()) {
      return;
    }

    if (!relayRequested) {
      relayRequested = true;
      applyMode("relay", handlers);
    }

    announceRelay();
    relayAnnounceTimer ??= setInterval(announceRelay, 250);
  };

  const handleTransferMessage = (message: TransferProtocolMessage) => {
    if (stopped) {
      return;
    }

    try {
      if (message.type === "file-start" && state.receivedFiles > 0) {
        const alreadyReceived = expectedManifest[state.receivedFiles - 1];
        const nextExpected = expectedManifest[state.receivedFiles];
        if (alreadyReceived && message.file.id === alreadyReceived.id) {
          state.currentFile = null;
          state.currentChunks = [];
          state.currentBytes = 0;
          return;
        }
        if (nextExpected && message.file.id !== nextExpected.id) {
          throw new Error("Sender resumed from the wrong file.");
        }
      }

      if (message.type === "chunk" && state.currentFile === null && state.receivedFiles > 0) {
        return;
      }

      if (message.type === "file-end" && state.currentFile === null && state.receivedFiles > 0) {
        const alreadyReceived = expectedManifest[state.receivedFiles - 1];
        if (alreadyReceived && message.fileId === alreadyReceived.id) {
          return;
        }
      }

      handleProtocolMessage(message, state, handlers);
      if (message.type === "file-end") {
        sendSignal(ws, {
          type: "receiver-ready",
          payload: { completedFiles: state.receivedFiles },
        });
      }
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : "接收文件失败。");
    }
  };

  const handleRelayMessage = (sequence: number, message: TransferProtocolMessage) => {
    if (sequence < nextRelaySequence) {
      return;
    }

    pendingRelayMessages.set(sequence, message);
    while (pendingRelayMessages.has(nextRelaySequence)) {
      const nextMessage = pendingRelayMessages.get(nextRelaySequence);
      pendingRelayMessages.delete(nextRelaySequence);
      nextRelaySequence += 1;
      if (nextMessage) {
        handleTransferMessage(nextMessage);
      }
    }
  };

  pc.addEventListener("datachannel", (event) => {
    const channel = event.channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      if (!relayRequested) {
        applyMode("direct", handlers);
      }
    });
    channel.addEventListener("message", (dataEvent) => {
      if (relayRequested) {
        return;
      }

      if (typeof dataEvent.data === "string") {
        const message = parseProtocolMessage(dataEvent.data);
        if (message) {
          handleTransferMessage(message);
        }
        return;
      }

      if (dataEvent.data instanceof ArrayBuffer) {
        handleTransferMessage({ type: "chunk", fileId: "chunk", bytes: dataEvent.data });
      }
    });
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "failed") {
      requestRelay();
    }
  });

  ws.addEventListener("message", async (event) => {
    const message = parseSignalMessage(event);
    if (!message || stopped) {
      return;
    }

    if (message.type === "offer") {
      if (preferRelayInTests()) {
        requestRelay();
        return;
      }

      await pc.setRemoteDescription(message.payload);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await awaitIceComplete(pc);
      if (pc.localDescription) {
        sendSignal(ws, { type: "answer", payload: pc.localDescription.toJSON() });
      }
      return;
    }

    if (message.type === "ice-candidate") {
      await pc.addIceCandidate(message.payload);
      return;
    }

    if (message.type === "mode") {
      if (message.payload.mode === "relay") {
        requestRelay();
        return;
      }

      applyMode(message.payload.mode, handlers);
      return;
    }

    if (message.type === "relay-message") {
      stopRelayAnnouncements();
      sendSignal(ws, { type: "relay-ack", payload: { sequence: message.payload.sequence } });
      handleRelayMessage(message.payload.sequence, fromRelayMessage(message.payload.message));
      return;
    }

    if (message.type === "transfer-complete") {
      stopRelayAnnouncements();
      handlers.onComplete();
      return;
    }

    if (message.type === "sender-left") {
      handlers.onEnded();
    }
  });

  await awaitSocketOpen(ws);
  sendSignal(ws, { type: "receiver-ready", payload: { completedFiles: receivedFiles.length } });

  if (preferRelayInTests()) {
    requestRelay();
  }

  return {
    stop() {
      stopped = true;
      stopRelayAnnouncements();
      pc.close();
      ws.close();
    },
    release() {
      stopped = true;
      stopRelayAnnouncements();
      pc.close();
      ws.close();
    },
  };
}
