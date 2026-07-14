import {
  type FileManifestItem,
  resumeProgressFromManifest,
  SENDER_RECONNECT_GRACE_MS,
} from "@p2pfile/shared";
import { getSignalUrl } from "../api";
import { RelayMessageQueue } from "./relay-queue";
import { fromRelayMessage } from "./relay-runtime";
import {
  applyMode,
  awaitSocketOpen,
  buildReceiverState,
  forceDirectFail,
  handleProtocolMessage,
  makePeerConnection,
  parseProtocolMessage,
  parseSignalWire,
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
  ws.binaryType = "arraybuffer";
  let relayCommitQueue: RelayMessageQueue | null = null;
  const pc = makePeerConnection(ws, handlers, "Connecting");
  const pendingIceCandidates: RTCIceCandidateInit[] = [];
  const pendingRelayMessages = new Map<number, TransferProtocolMessage>();
  const seededCommittedBytes = seedCommittedBytes(receivedFiles, committedBytesByFileId);
  const state = buildReceiverState(expectedManifest, seededCommittedBytes, sessionId);
  let nextRelaySequence = 0;
  let relaySequenceInitialized = false;
  let relayRequested = false;
  let relayAnnounceTimer: ReturnType<typeof setInterval> | null = null;
  let dataChannelOpen = false;
  let stopped = false;
  const getRelayCommitQueue = () => {
    relayCommitQueue ??= new RelayMessageQueue((data) => ws.send(data), {
      ackTimeoutMs: SENDER_RECONNECT_GRACE_MS + 1_000,
    });
    return relayCommitQueue;
  };
  const stopRelayCommitQueue = () => {
    relayCommitQueue?.stop();
    relayCommitQueue = null;
  };
  const receiverInstanceId = makeReceiverInstanceId();
  if (seededCommittedBytes.size > 0) {
    restoreProgressState(expectedManifest, receivedFiles, handlers, seededCommittedBytes);
  }

  const currentDurableProgress = () => {
    const committed = new Map<string, number>();
    for (const [fileId, bytes] of state.committedBytesByFileId) {
      if (bytes > 0 || state.fileStates.get(fileId)?.state === "completed") {
        committed.set(fileId, bytes);
      }
    }
    return resumeProgressFromManifest(expectedManifest, committed);
  };

  const sendReceiverProgress = () => {
    sendSignal(ws, {
      type: "receiver-ready",
      payload: {
        progress: currentDurableProgress(),
        completedFiles: state.receivedFiles,
        receiverInstanceId,
      },
    });
  };

  const announceRelay = () => {
    // Progress must arrive first so a reattached relay sender cannot resend
    // from an older acknowledged offset.
    sendReceiverProgress();
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
          if (stopped) return;
          if (viaRelay || relayRequested) {
            void getRelayCommitQueue()
              .send(ack)
              .catch(() => undefined);
            return;
          }
          if (dataChannelOpen) {
            for (const sender of activeDirectChannels) sender.send(JSON.stringify(ack));
          }
        },
      });
      if (stopped) return;
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
      stopRelayCommitQueue();
      pc.close();
      ws.close();
      handlers.onError(error instanceof Error ? error.message : "接收文件失败。");
    }
  };

  let processingChain = Promise.resolve();

  const handleRelayMessage = (sequence: number, message: TransferProtocolMessage) => {
    if (!relaySequenceInitialized) {
      if (message.type !== "manifest") {
        return;
      }
      nextRelaySequence = sequence;
      relaySequenceInitialized = true;
    }
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
    channel.addEventListener(
      "close",
      () => {
        activeDirectChannels.delete(channel);
        if (activeDirectChannels.size === 0) {
          dataChannelOpen = false;
        }
      },
      { once: true },
    );
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

      const raw = dataEvent.data;
      if (raw instanceof ArrayBuffer) {
        const message = parseProtocolMessage(raw);
        if (message) handleTransferMessage(message);
        return;
      }
      if (ArrayBuffer.isView(raw)) {
        const view = raw as ArrayBufferView;
        const copy = new Uint8Array(view.byteLength);
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        const message = parseProtocolMessage(copy.buffer);
        if (message) handleTransferMessage(message);
      }
    });
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "failed") {
      requestRelay();
    }
  });

  ws.addEventListener("message", async (event) => {
    if (stopped) {
      return;
    }
    const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    if (stopped) {
      return;
    }
    const wire = parseSignalWire({ data });
    if (!wire) {
      return;
    }

    if (wire.kind === "binary-relay-chunk") {
      stopRelayAnnouncements();
      sendSignal(ws, { type: "relay-ack", payload: { sequence: wire.sequence } });
      handleRelayMessage(wire.sequence, wire.message);
      return;
    }

    const message = wire.message;
    if (message.type === "offer") {
      if (preferRelayInTests() || forceDirectFail()) {
        requestRelay();
        return;
      }

      await pc.setRemoteDescription(message.payload);
      while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        if (candidate) await pc.addIceCandidate(candidate);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (pc.localDescription) {
        sendSignal(ws, { type: "answer", payload: pc.localDescription.toJSON() });
      }
      return;
    }

    if (message.type === "ice-candidate") {
      if (pc.remoteDescription === null) {
        pendingIceCandidates.push(message.payload);
      } else {
        await pc.addIceCandidate(message.payload);
      }
      return;
    }

    if (message.type === "mode") {
      if (message.payload.mode === "relay") {
        // Always enter the relay receive path. A stale dataChannelOpen from a
        // closed Direct attempt must not keep commits on a dead DataChannel.
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

    if (message.type === "relay-ack") {
      relayCommitQueue?.acknowledge(message.payload.sequence);
      return;
    }

    if (message.type === "transfer-complete") {
      stopRelayAnnouncements();
      stopRelayCommitQueue();
      handlers.onComplete();
      return;
    }

    if (message.type === "sender-reconnecting") {
      handlers.onStatus("Waiting for peer reconnect");
      return;
    }

    if (message.type === "sender-left") {
      stopRelayCommitQueue();
      handlers.onEnded();
    }
  });

  ws.addEventListener("close", () => {
    if (relayRequested || relayCommitQueue) stopped = true;
    stopRelayAnnouncements();
    stopRelayCommitQueue();
  });

  await awaitSocketOpen(ws);
  sendReceiverProgress();

  if (preferRelayInTests()) {
    requestRelay();
  }

  return {
    stop() {
      stopped = true;
      stopRelayAnnouncements();
      stopRelayCommitQueue();
      pc.close();
      ws.close();
    },
    release() {
      stopped = true;
      stopRelayAnnouncements();
      stopRelayCommitQueue();
      pc.close();
      ws.close();
    },
  };
}
