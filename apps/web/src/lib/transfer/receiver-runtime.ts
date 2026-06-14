import { type FileManifestItem, resumeProgressFromManifest } from "@p2pfile/shared";
import { getSignalUrl } from "../api";
import { fromRelayMessage, toRelayMessage } from "./relay-runtime";
import {
  applyMode,
  awaitIceComplete,
  awaitSocketOpen,
  buildReceiverState,
  forceDirectFail,
  handleProtocolMessage,
  makePeerConnection,
  parseProtocolMessage,
  parseSignalMessage,
  preferRelayInTests,
  relayAvailable,
  sendSignal,
} from "./runtime-shared";
import type {
  BrowserSignalMessage,
  ReceivedFile,
  ReceiverRuntime,
  ReceiverRuntimeHandlers,
  TransferProtocolMessage,
} from "./types";

function restoreProgressState(
  expectedManifest: FileManifestItem[],
  receivedFiles: ReceivedFile[],
  handlers: ReceiverRuntimeHandlers,
  committedBytesByFileId: ReadonlyMap<string, number>,
) {
  const committed = seedCommittedBytes(receivedFiles, committedBytesByFileId);
  const progress = resumeProgressFromManifest(expectedManifest, committed);
  const activeIndex = progress.files.findIndex(
    (file) => !file.completed && file.committedBytes > 0,
  );
  const nextIndex =
    activeIndex >= 0 ? activeIndex : progress.files.findIndex((file) => !file.completed);
  const nextFile = nextIndex >= 0 ? expectedManifest[nextIndex] : null;
  const nextProgress = nextIndex >= 0 ? progress.files[nextIndex] : null;
  handlers.onProgress({
    fileId: nextFile?.id ?? null,
    fileName: nextFile?.name ?? null,
    fileBytes: nextProgress?.committedBytes ?? 0,
    fileTotalBytes: nextFile?.size ?? 0,
    completedBytes: progress.files.reduce((sum, file) => sum + file.committedBytes, 0),
    totalBytes: expectedManifest.reduce((sum, file) => sum + file.size, 0),
    completedFiles: progress.files.filter((file) => file.completed).length,
    totalFiles: expectedManifest.length,
    files: expectedManifest.map((file, index) => {
      const fileProgress = progress.files[index];
      const fileBytes = fileProgress?.committedBytes ?? 0;
      return {
        fileId: file.id,
        fileName: file.name,
        fileBytes,
        fileTotalBytes: file.size,
        state: fileProgress?.completed ? "completed" : fileBytes > 0 ? "reconnecting" : "queued",
      };
    }),
  });
}

function progressFromState(
  expectedManifest: FileManifestItem[],
  completedFiles: ReceivedFile[],
  committedBytesByFileId: ReadonlyMap<string, number>,
) {
  const committed = seedCommittedBytes(completedFiles, committedBytesByFileId);
  return resumeProgressFromManifest(expectedManifest, committed);
}

function nextRelayEnvelope(
  sequence: number,
  message: TransferProtocolMessage,
): BrowserSignalMessage & { type: "relay-message" } {
  return {
    type: "relay-message",
    payload: {
      sequence,
      message: toRelayMessage(message),
    },
  };
}
function seedCommittedBytes(
  completedFiles: ReceivedFile[],
  committedBytesByFileId: ReadonlyMap<string, number>,
) {
  const committed = new Map(committedBytesByFileId);
  for (const file of completedFiles) {
    committed.set(file.id, file.size);
  }
  return committed;
}
function makeReceiverInstanceId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export async function startReceiverRuntime(
  sessionId: string,
  receiverToken: string,
  expectedManifest: FileManifestItem[],
  handlers: ReceiverRuntimeHandlers,
  receivedFiles: ReceivedFile[] = [],
  committedBytesByFileId: ReadonlyMap<string, number> = new Map(),
): Promise<ReceiverRuntime> {
  const ws = new WebSocket(getSignalUrl(sessionId, "receiver", receiverToken));
  const pc = makePeerConnection(ws, handlers, "Connecting");
  const pendingRelayMessages = new Map<number, TransferProtocolMessage>();
  const seededCommittedBytes = seedCommittedBytes(receivedFiles, committedBytesByFileId);
  const state = buildReceiverState(expectedManifest, seededCommittedBytes, sessionId);
  let nextRelaySequence = 0;
  let nextOutgoingRelaySequence = 0;
  let relayRequested = false;
  let relayAnnounceTimer: ReturnType<typeof setInterval> | null = null;
  let dataChannelOpen = false;
  let stopped = false;
  const receiverInstanceId = makeReceiverInstanceId();
  if (seededCommittedBytes.size > 0) {
    restoreProgressState(expectedManifest, receivedFiles, handlers, seededCommittedBytes);
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

  const processTransferMessage = async (message: TransferProtocolMessage, viaRelay = false) => {
    if (stopped) {
      return;
    }

    try {
      await handleProtocolMessage(message, state, handlers, {
        onChunkCommit(ack) {
          if (viaRelay || relayRequested) {
            sendSignal(ws, nextRelayEnvelope(nextOutgoingRelaySequence, ack));
            nextOutgoingRelaySequence += 1;
            return;
          }
          if (dataChannelOpen) {
            for (const sender of activeDirectChannels) sender.send(JSON.stringify(ack));
          }
        },
      });
      if (message.type === "file-end") {
        sendSignal(ws, {
          type: "receiver-ready",
          payload: {
            progress: resumeProgressFromManifest(expectedManifest, state.committedBytesByFileId),
            completedFiles: state.receivedFiles,
            receiverInstanceId,
          },
        });
      }
    } catch (error) {
      stopped = true;
      stopRelayAnnouncements();
      pc.close();
      ws.close();
      handlers.onError(error instanceof Error ? error.message : "接收文件失败。");
    }
  };

  let processingChain = Promise.resolve();

  const handleRelayMessage = (sequence: number, message: TransferProtocolMessage) => {
    if (sequence < nextRelaySequence) {
      if (sequence !== 0 || message.type !== "manifest") {
        return;
      }
      pendingRelayMessages.clear();
      nextRelaySequence = 0;
    }

    pendingRelayMessages.set(sequence, message);
    while (pendingRelayMessages.has(nextRelaySequence)) {
      const nextMessage = pendingRelayMessages.get(nextRelaySequence);
      pendingRelayMessages.delete(nextRelaySequence);
      nextRelaySequence += 1;
      if (nextMessage) {
        handleTransferMessage(nextMessage, true);
      }
    }
  };

  const handleTransferMessage = (message: TransferProtocolMessage, viaRelay = false) => {
    processingChain = processingChain.then(() => processTransferMessage(message, viaRelay));
  };

  const activeDirectChannels = new Set<RTCDataChannel>();
  pc.addEventListener("datachannel", (event) => {
    const channel = event.channel;
    activeDirectChannels.add(channel);
    channel.binaryType = "arraybuffer";
    channel.addEventListener("close", () => activeDirectChannels.delete(channel), { once: true });
    channel.addEventListener("open", () => {
      dataChannelOpen = true;
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

      if (dataEvent.data instanceof ArrayBuffer && state.currentFile) {
        handleTransferMessage({
          type: "chunk",
          fileId: state.currentFile.id,
          chunkIndex: Math.floor(state.currentBytes / (64 * 1024)),
          offset: state.currentBytes,
          bytes: dataEvent.data,
          chunkDigest: "",
        });
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
      if (preferRelayInTests() || forceDirectFail()) {
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
        if (dataChannelOpen) {
          applyMode("relay", handlers);
        } else {
          requestRelay();
        }
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

    if (message.type === "sender-reconnecting") {
      handlers.onStatus("Waiting for peer reconnect");
      return;
    }

    if (message.type === "sender-left") {
      handlers.onEnded();
    }
  });

  await awaitSocketOpen(ws);
  sendSignal(ws, {
    type: "receiver-ready",
    payload: {
      progress: progressFromState(expectedManifest, receivedFiles, committedBytesByFileId),
      completedFiles: receivedFiles.length,
      receiverInstanceId,
    },
  });

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
