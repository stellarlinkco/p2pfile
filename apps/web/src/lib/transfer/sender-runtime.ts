import type { FileManifestItem } from "@p2pfile/shared";
import { getSignalUrl } from "../api";
import { RelayMessageQueue } from "./relay-queue";
import {
  applyMode,
  awaitIceComplete,
  awaitSocketOpen,
  makePeerConnection,
  preferRelayInTests,
  sendSignal,
} from "./runtime-shared";
import { SenderFallbackController } from "./sender-fallback";
import {
  buildTransferPlan,
  reportResumeProgress,
  sendFiles,
  sendFilesViaRelay,
} from "./sender-runtime-helpers";
import { attachSenderSignalHandler } from "./sender-signal-handler";
import type { SenderRuntime, SenderRuntimeHandlers } from "./types";

export function shouldReuseDirectAttempt(
  pc: RTCPeerConnection | null,
  channel: RTCDataChannel | null,
) {
  if (!pc || !channel) {
    return false;
  }

  return pc.signalingState !== "closed" && channel.readyState === "connecting";
}

export async function startSenderRuntime(
  sessionId: string,
  senderToken: string,
  files: File[],
  manifest: FileManifestItem[],
  handlers: SenderRuntimeHandlers,
): Promise<SenderRuntime> {
  const ws = new WebSocket(getSignalUrl(sessionId, "sender", senderToken));
  const relayOnly = preferRelayInTests();
  const plan = buildTransferPlan(files, manifest);
  const queue = new RelayMessageQueue((message) => sendSignal(ws, message));
  let stopped = false;
  let completed = false;
  let transferring = false;
  let confirmedCompletedFiles = 0;
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
    completed = true;
    transferring = false;
    queue.reset();
    fallback.stopRelayMode();
    closeDirectTransport();
    handlers.onComplete();
  };

  const updateConfirmedCompletedFiles = (nextCompletedFiles: number) => {
    const normalizedCount = Math.max(0, Math.min(nextCompletedFiles, plan.manifest.length));
    if (normalizedCount === confirmedCompletedFiles) return;
    confirmedCompletedFiles = normalizedCount;
    reportResumeProgress(plan, confirmedCompletedFiles, handlers);
  };

  const currentTransferActive = (token: number) =>
    !stopped && !completed && transferring && token === transferToken;

  const handleTransferFailure = (error: unknown) => {
    if (stopped || completed) return;
    const message = error instanceof Error ? error.message : "传输失败。";
    if (message === "Transfer restarted.") return;
    transferring = false;
    queue.reset();
    if (message === "Data channel is not open.") {
      handlers.onStatus("Waiting for receiver");
      return;
    }
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
        handlers,
        confirmedCompletedFiles,
        () => currentTransferActive(token) && channel === nextChannel,
      );
    } catch (error) {
      if (channel === nextChannel) closeDirectTransport();
      handleTransferFailure(error);
    }
  };

  const continueFallback = () => {
    if (stopped || completed) return;
    fallback.continue({
      startTurnAttempt: () => createDirectAttempt("turn"),
      startRelayTransfer: () => void beginRelayTransfer(),
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
      await sendFilesViaRelay(queue, files, plan, handlers, confirmedCompletedFiles, () =>
        currentTransferActive(token),
      );
    } catch (error) {
      fallback.markRelayFailed();
      continueFallback();
      handleTransferFailure(error);
    }
  };

  const sendOffer = async (nextPc: RTCPeerConnection) => {
    try {
      const offer = await nextPc.createOffer();
      await nextPc.setLocalDescription(offer);
      await awaitIceComplete(nextPc);
      if (stopped || completed || pc !== nextPc) return;
      if (nextPc.localDescription) {
        sendSignal(ws, { type: "offer", payload: nextPc.localDescription.toJSON() });
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
      sendSignal(ws, { type: "offer", payload: pc.localDescription.toJSON() });
      return;
    }
    void sendOffer(pc);
  };

  const handleReceiverReady = (nextCompletedFiles: number) => {
    updateConfirmedCompletedFiles(nextCompletedFiles);
    if (completed || stopped || transferring) return;
    if (fallback.mode === "ws-relay") {
      void beginRelayTransfer();
      return;
    }
    if (shouldReuseDirectAttempt(pc, channel)) {
      resendPendingOffer();
      return;
    }
    createDirectAttempt();
  };

  attachSenderSignalHandler({
    ws,
    queue,
    handlers,
    isStopped: () => stopped,
    getPeerConnection: () => pc,
    handleReceiverReady,
    markDirectFailed: () => fallback.markDirectFailed(),
    continueFallback,
    stopRelayMode: () => fallback.stopRelayMode(),
    markCompleted,
  });

  await awaitSocketOpen(ws);
  if (relayOnly) {
    const sendRelayMode = () => sendSignal(ws, { type: "mode", payload: { mode: "relay" } });
    fallback.startRelayMode(sendRelayMode);
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
      sendSignal(ws, { type: "sender-left", payload: {} });
    },
  };
}
