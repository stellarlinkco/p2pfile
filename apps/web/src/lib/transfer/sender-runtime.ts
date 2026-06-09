import { getSignalUrl } from "../api";
import { RelayMessageQueue } from "./relay-queue";
import {
  applyMode,
  awaitIceComplete,
  awaitSocketOpen,
  makePeerConnection,
  parseSignalMessage,
  preferRelayInTests,
  sendSignal,
} from "./runtime-shared";
import {
  buildTransferPlan,
  reportResumeProgress,
  sendFiles,
  sendFilesViaRelay,
} from "./sender-runtime-helpers";
import type { SenderRuntime, SenderRuntimeHandlers } from "./types";

export async function startSenderRuntime(
  sessionId: string,
  senderToken: string,
  files: File[],
  handlers: SenderRuntimeHandlers,
): Promise<SenderRuntime> {
  const ws = new WebSocket(getSignalUrl(sessionId, "sender", senderToken));
  const relayOnly = preferRelayInTests();
  const plan = buildTransferPlan(files);
  const queue = new RelayMessageQueue((message) => sendSignal(ws, message));
  let relayModeTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let completed = false;
  let transferring = false;
  let confirmedCompletedFiles = 0;
  let preferredMode: "direct" | "relay" = relayOnly ? "relay" : "direct";
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let transferToken = 0;

  const stopRelayMode = () => {
    if (relayModeTimer) {
      clearInterval(relayModeTimer);
      relayModeTimer = null;
    }
  };

  const closeDirectTransport = () => {
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
    stopRelayMode();
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
    preferredMode = "direct";
    transferring = true;
    const token = transferToken + 1;
    transferToken = token;
    applyMode("direct", handlers);
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

  const beginRelayTransfer = async () => {
    if (stopped || completed || transferring) return;
    preferredMode = "relay";
    closeDirectTransport();
    stopRelayMode();
    queue.reset();
    transferring = true;
    const token = transferToken + 1;
    transferToken = token;
    try {
      await sendFilesViaRelay(queue, files, plan, handlers, confirmedCompletedFiles, () =>
        currentTransferActive(token),
      );
    } catch (error) {
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

  const createDirectAttempt = () => {
    if (stopped || completed || relayOnly) return;
    stopRelayMode();
    closeDirectTransport();
    const nextPc = makePeerConnection(ws, handlers, "Waiting for receiver");
    const nextChannel = nextPc.createDataChannel("files", { ordered: true });
    nextChannel.binaryType = "arraybuffer";
    nextChannel.addEventListener("open", () => {
      if (channel === nextChannel) {
        void beginDirectTransfer(nextChannel);
      }
    });
    nextPc.addEventListener("iceconnectionstatechange", () => {
      if (pc !== nextPc) return;
      if (nextPc.iceConnectionState === "failed") {
        preferredMode = "relay";
        void beginRelayTransfer();
      }
    });
    pc = nextPc;
    channel = nextChannel;
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
    if (preferredMode === "relay") {
      void beginRelayTransfer();
      return;
    }
    if (pc && pc.signalingState !== "closed" && channel?.readyState !== "open") {
      resendPendingOffer();
      return;
    }
    createDirectAttempt();
  };

  ws.addEventListener("message", async (event) => {
    const message = parseSignalMessage(event);
    if (!message || stopped) return;
    if (message.type === "receiver-ready") {
      handleReceiverReady(message.payload.completedFiles);
      return;
    }
    if (message.type === "answer") {
      if (pc && pc.remoteDescription === null) {
        try {
          await pc.setRemoteDescription(message.payload);
        } catch {
          // Ignore stale answers from a superseded offer.
        }
      }
      return;
    }
    if (message.type === "ice-candidate") {
      if (pc) {
        try {
          await pc.addIceCandidate(message.payload);
        } catch {
          // Ignore stale ICE candidates from a superseded offer.
        }
      }
      return;
    }
    if (message.type === "mode") {
      preferredMode = message.payload.mode;
      applyMode(message.payload.mode, handlers);
      if (message.payload.mode === "relay") {
        await beginRelayTransfer();
      }
      return;
    }
    if (message.type === "relay-ready") {
      preferredMode = "relay";
      await beginRelayTransfer();
      return;
    }
    if (message.type === "relay-ack") {
      queue.acknowledge(message.payload.sequence);
      stopRelayMode();
      return;
    }
    if (message.type === "transfer-complete") {
      markCompleted();
    }
  });

  await awaitSocketOpen(ws);
  if (relayOnly) {
    const sendRelayMode = () => sendSignal(ws, { type: "mode", payload: { mode: "relay" } });
    sendRelayMode();
    relayModeTimer = setInterval(sendRelayMode, 250);
  } else {
    createDirectAttempt();
  }

  return {
    stop() {
      stopped = true;
      transferring = false;
      stopRelayMode();
      queue.stop();
      closeDirectTransport();
      ws.close();
    },
    markSenderLeft() {
      sendSignal(ws, { type: "sender-left", payload: {} });
    },
  };
}
