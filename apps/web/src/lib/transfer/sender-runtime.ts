import { type FileManifestItem, MANIFEST_CHUNK_BYTES, type ResumeProgress } from "@p2pfile/shared";
import { getSession, getSignalUrl } from "../api";
import { RelayMessageQueue } from "./relay-queue";
import {
  applyMode,
  awaitSocketOpen,
  makePeerConnection,
  preferRelayInTests,
  sendSignal,
  trySendSignal,
} from "./runtime-shared";
import { SenderFallbackController } from "./sender-fallback";
import {
  buildTransferPlan,
  completedFilesFromProgress,
  initialResumeProgress,
  mergeResumeProgress,
  reportResumeProgress,
  sendFiles,
  sendFilesViaRelay,
} from "./sender-runtime-helpers";
import { attachSenderSignalHandler } from "./sender-signal-handler";
import type { BrowserSignalMessage, SenderRuntime, SenderRuntimeHandlers } from "./types";

export function shouldReuseDirectAttempt(
  pc: RTCPeerConnection | null,
  channel: RTCDataChannel | null,
) {
  if (!pc || !channel) {
    return false;
  }

  return pc.signalingState !== "closed" && channel.readyState === "connecting";
}

function openSenderSignalSocket(sessionId: string, senderToken: string) {
  const ws = new WebSocket(getSignalUrl(sessionId, "sender", senderToken));
  // Required for binary relay chunk frames; default "blob" drops them in parseSignalWire.
  ws.binaryType = "arraybuffer";
  return ws;
}

export async function startSenderRuntime(
  sessionId: string,
  senderToken: string,
  files: File[],
  manifest: FileManifestItem[],
  handlers: SenderRuntimeHandlers,
): Promise<SenderRuntime> {
  let ws = openSenderSignalSocket(sessionId, senderToken);
  const relayOnly = preferRelayInTests();
  const plan = buildTransferPlan(files, manifest);
  const testAckTimeoutMs = (globalThis as { __P2PFILE_TEST_RELAY_ACK_TIMEOUT_MS__?: number })
    .__P2PFILE_TEST_RELAY_ACK_TIMEOUT_MS__;
  const queue = new RelayMessageQueue(
    (data) => sendSignal(ws, data),
    typeof testAckTimeoutMs === "number" && testAckTimeoutMs > 0
      ? {
          ackTimeoutMs: testAckTimeoutMs,
          // Keep resend out of the short test window so timeout is the first signal.
          initialRtoMs: Math.max(testAckTimeoutMs * 4, 60_000),
          maxRtoMs: Math.max(testAckTimeoutMs * 4, 60_000),
        }
      : undefined,
  );
  let stopped = false;
  let completed = false;
  let transferring = false;
  let receiverProgress: ResumeProgress = initialResumeProgress(plan);
  let receiverInstanceId: string | null = null;
  const fallback = new SenderFallbackController(relayOnly, handlers);
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let transferToken = 0;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFallbackTimer = () => {
    if (!fallbackTimer) {
      return;
    }

    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };

  const closeDirectTransport = () => {
    clearFallbackTimer();
    const nextChannel = channel;
    const nextPc = pc;
    channel = null;
    pc = null;
    nextChannel?.close();
    nextPc?.close();
  };

  const markCompleted = () => {
    if (completed) return;
    receiverProgress = {
      manifestHash: plan.manifestHash,
      files: plan.manifest.map((file) => ({
        fileId: file.id,
        size: file.size,
        chunkSize:
          receiverProgress.files.find((progress) => progress.fileId === file.id)?.chunkSize ??
          MANIFEST_CHUNK_BYTES,
        committedBytes: file.size,
        completed: true,
      })),
    };
    reportResumeProgress(plan, receiverProgress, handlers);
    completed = true;
    transferring = false;
    queue.reset();
    fallback.stopRelayMode();
    closeDirectTransport();
    handlers.onComplete();
  };

  const updateReceiverProgress = (nextProgress: ResumeProgress, authoritativeReset = false) => {
    const normalized = mergeResumeProgress(plan, receiverProgress, nextProgress, {
      authoritativeReset,
    });
    if (JSON.stringify(normalized) === JSON.stringify(receiverProgress)) return false;
    receiverProgress = normalized;
    reportResumeProgress(plan, receiverProgress, handlers);
    return true;
  };
  const receiverProgressIsComplete = () =>
    completedFilesFromProgress(receiverProgress) === plan.manifest.length &&
    receiverProgress.files.every((file) => file.completed && file.committedBytes === file.size);

  const currentTransferActive = (token: number) =>
    !stopped && !completed && transferring && token === transferToken;
  const activeTransferHandlers = (token: number): SenderRuntimeHandlers => ({
    ...handlers,
    onProgress(nextProgress) {
      if (currentTransferActive(token)) handlers.onProgress(nextProgress);
    },
  });
  const waitForCompletedSessionView = async (token: number) => {
    while (currentTransferActive(token)) {
      const session = await getSession(sessionId);
      if (session.completed) {
        markCompleted();
        return;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
  };

  const isRecoverableTransferError = (message: string) =>
    message === "Data channel is not open." ||
    message === "Relay peer unavailable." ||
    message === "Relay signaling disconnected." ||
    message.startsWith("Relay acknowledgement timed out");

  const handleTransferFailure = (error: unknown) => {
    if (stopped || completed) return;
    const message = error instanceof Error ? error.message : "传输失败。";
    if (message === "Transfer restarted.") return;
    // Receiver replacement, transient signal loss, or a single timed-out relay
    // frame can close Direct / stall Relay mid-transfer. Fresh receiver-ready /
    // relay-ready owns recovery instead of a hard terminal failure.
    if (isRecoverableTransferError(message)) {
      const wasRelay = fallback.mode === "ws-relay" || message.startsWith("Relay ");
      transferring = false;
      queue.reset();
      if (wasRelay && !stopped && !completed) {
        handlers.onStatus("Waiting for peer reconnect");
        // Receiver stops relay-ready announcements after the first frame.
        // Re-announce mode so a live peer can restart delivery without a full page reload.
        requestRelayReady();
      }
      return;
    }
    transferring = false;
    queue.reset();
    handlers.onError(message);
  };

  const beginDirectTransfer = async (nextChannel: RTCDataChannel) => {
    if (stopped || completed || transferring || channel !== nextChannel) return;
    const transportMode = fallback.mode === "turn" ? "relay" : "direct";
    transferring = true;
    const token = transferToken + 1;
    transferToken = token;
    applyMode(transportMode, handlers);
    if (transportMode === "relay") {
      sendSignal(ws, { type: "mode", payload: { mode: "relay" } });
    }
    try {
      await sendFiles(
        nextChannel,
        files,
        plan,
        activeTransferHandlers(token),
        receiverProgress,
        () => currentTransferActive(token) && channel === nextChannel,
        updateReceiverProgress,
      );
      await waitForCompletedSessionView(token);
    } catch (error) {
      if (channel === nextChannel) closeDirectTransport();
      handleTransferFailure(error);
    }
  };

  const requestRelayReady = () => {
    fallback.startRelayMode(() => trySendSignal(ws, { type: "mode", payload: { mode: "relay" } }));
  };

  const continueFallback = () => {
    if (stopped || completed) return;
    fallback.continue({
      startTurnAttempt: () => createDirectAttempt("turn"),
      startRelayTransfer: requestRelayReady,
    });
  };

  const beginRelayTransfer = async () => {
    if (stopped || completed || transferring) return;
    fallback.mode = "ws-relay";
    closeDirectTransport();
    fallback.stopRelayMode();
    queue.reset();
    transferring = true;
    const token = transferToken + 1;
    transferToken = token;
    try {
      sendSignal(ws, { type: "mode", payload: { mode: "relay" } });
      await sendFilesViaRelay(
        queue,
        files,
        plan,
        activeTransferHandlers(token),
        receiverProgress,
        () => currentTransferActive(token),
        (progress) => {
          if (!currentTransferActive(token)) return;
          updateReceiverProgress(progress);
        },
      );
      await waitForCompletedSessionView(token);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "Transfer restarted." || isRecoverableTransferError(error.message))
      ) {
        handleTransferFailure(error);
        return;
      }
      fallback.markRelayFailed();
      continueFallback();
      handleTransferFailure(error);
    }
  };

  const sendOffer = async (nextPc: RTCPeerConnection) => {
    try {
      const offer = await nextPc.createOffer();
      await nextPc.setLocalDescription(offer);
      if (stopped || completed || pc !== nextPc) return;
      if (nextPc.localDescription) {
        trySendSignal(ws, { type: "offer", payload: nextPc.localDescription.toJSON() });
      }
    } catch (error) {
      if (stopped || completed || pc !== nextPc) return;
      handlers.onError(error instanceof Error ? error.message : "生成连接邀请失败。");
    }
  };

  const createDirectAttempt = (mode: "direct" | "turn" = "direct") => {
    if (stopped || completed || relayOnly) return;
    clearFallbackTimer();
    fallback.stopRelayMode();
    closeDirectTransport();
    fallback.noteDirectAttempt(mode);
    const nextPc = makePeerConnection(
      ws,
      handlers,
      "Waiting for receiver",
      mode === "turn"
        ? {
            iceTransportPolicy: "relay",
            connectedMode: "relay",
          }
        : undefined,
    );
    const nextChannel = nextPc.createDataChannel("files", { ordered: true });
    nextChannel.binaryType = "arraybuffer";
    nextChannel.addEventListener("open", () => {
      if (channel === nextChannel) {
        clearFallbackTimer();
        void beginDirectTransfer(nextChannel);
      }
    });
    nextPc.addEventListener("iceconnectionstatechange", () => {
      if (pc !== nextPc) return;
      if (nextPc.iceConnectionState === "failed") {
        fallback.markDirectFailed();
        continueFallback();
      }
    });
    pc = nextPc;
    channel = nextChannel;
    fallbackTimer = setTimeout(() => {
      if (pc === nextPc && channel === nextChannel) {
        fallback.markDirectFailed();
        continueFallback();
      }
    }, 15_000);
    void sendOffer(nextPc);
  };

  const resendPendingOffer = () => {
    if (!pc || pc.signalingState === "closed" || channel?.readyState === "open") return;
    if (pc.localDescription && pc.remoteDescription === null) {
      trySendSignal(ws, { type: "offer", payload: pc.localDescription.toJSON() });
      return;
    }
    void sendOffer(pc);
  };

  const recordSenderTestEvent = (event: Record<string, unknown>) => {
    const target = globalThis as {
      __P2PFILE_TEST_TRANSFER_EVENTS__?: Record<string, unknown>[];
    };
    target.__P2PFILE_TEST_TRANSFER_EVENTS__?.push(event);
  };

  const handleReceiverReady = (
    payload: Extract<BrowserSignalMessage, { type: "receiver-ready" }>["payload"],
  ) => {
    if (completed || stopped) return;
    recordSenderTestEvent({ type: "sender-receiver-ready", mode: fallback.mode });
    const nextInstanceId =
      typeof payload.receiverInstanceId === "string" ? payload.receiverInstanceId : null;
    const receiverRestarted = receiverInstanceId !== null && nextInstanceId !== receiverInstanceId;
    if (nextInstanceId !== null) {
      receiverInstanceId = nextInstanceId;
    }
    const progressChanged = updateReceiverProgress(payload.progress, receiverRestarted);
    if (!receiverProgressIsComplete() && (receiverRestarted || (transferring && progressChanged))) {
      // A restarted receiver must not retain an in-flight transfer or relay decision.
      transferToken += 1;
      transferring = false;
      queue.reset();
      closeDirectTransport();
    }
    if (transferring) return;
    if (fallback.mode === "ws-relay") {
      requestRelayReady();
      return;
    }
    if (shouldReuseDirectAttempt(pc, channel)) {
      resendPendingOffer();
      return;
    }
    createDirectAttempt();
  };

  const canPreserveDirectTransport = () => {
    const iceState = pc?.iceConnectionState;
    const peerState = pc?.connectionState;
    const transportFailed =
      iceState === "closed" ||
      peerState === "failed" ||
      peerState === "closed" ||
      (iceState === "failed" && !peerState);
    return (
      transferring &&
      fallback.mode !== "ws-relay" &&
      channel?.readyState === "open" &&
      pc?.signalingState !== "closed" &&
      !transportFailed
    );
  };

  const resetDirectTransportIfNeeded = () => {
    if (canPreserveDirectTransport()) return true;
    transferring = false;
    queue.reset();
    closeDirectTransport();
    return false;
  };

  const reattachSignalSocket = () => {
    if (stopped || completed) return;
    resetDirectTransportIfNeeded();
    handlers.onStatus("Waiting for peer reconnect");
    ws = openSenderSignalSocket(sessionId, senderToken);
    attachSignalSocket(ws);
    void awaitSocketOpen(ws)
      .then(() => {
        if (stopped || completed) return;
        if (resetDirectTransportIfNeeded()) return;
        if (fallback.mode === "ws-relay" || relayOnly) {
          fallback.stopRelayMode();
          requestRelayReady();
          return;
        }
        createDirectAttempt();
      })
      .catch((error) => {
        if (!stopped && !completed) {
          handlers.onError(
            error instanceof Error ? error.message : "Signal socket reconnect failed.",
          );
        }
      });
  };

  const attachSignalSocket = (signalSocket: WebSocket) => {
    attachSenderSignalHandler({
      ws: signalSocket,
      queue,
      handlers,
      isStopped: () => stopped || signalSocket !== ws,
      getPeerConnection: () => pc,
      handleReceiverReady,
      markDirectFailed: () => fallback.markDirectFailed(),
      startRelayTransfer: () => void beginRelayTransfer(),
      stopRelayMode: () => fallback.stopRelayMode(),
      markCompleted,
    });
    signalSocket.addEventListener("close", (event) => {
      if (stopped || completed || signalSocket !== ws) return;
      if (event.reason === "replaced") {
        stopped = true;
        transferring = false;
        fallback.stopRelayMode();
        queue.stop();
        closeDirectTransport();
        return;
      }
      // Transient signal drops reattach; peer loss surfaces via relay-nack / ack timeout.
      reattachSignalSocket();
    });
  };

  attachSignalSocket(ws);

  await awaitSocketOpen(ws);
  if (relayOnly) {
    requestRelayReady();
  } else {
    createDirectAttempt();
  }

  return {
    stop() {
      stopped = true;
      transferring = false;
      fallback.stopRelayMode();
      queue.stop();
      closeDirectTransport();
      ws.close();
    },
    markSenderLeft() {
      trySendSignal(ws, { type: "sender-left", payload: {} });
      stopped = true;
      transferring = false;
      ws.close();
    },
  };
}
