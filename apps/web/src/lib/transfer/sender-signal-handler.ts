import type { RelayMessageQueue } from "./relay-queue";
import { fromRelayMessage } from "./relay-runtime";
import { applyMode, parseSignalMessage, sendSignal } from "./runtime-shared";
import type { BrowserSignalMessage, SenderRuntimeHandlers } from "./types";

type SenderSignalHandlerContext = {
  ws: WebSocket;
  queue: RelayMessageQueue;
  handlers: SenderRuntimeHandlers;
  isStopped: () => boolean;
  getPeerConnection: () => RTCPeerConnection | null;
  handleReceiverReady: (
    payload: Extract<BrowserSignalMessage, { type: "receiver-ready" }>["payload"],
  ) => void;
  markDirectFailed: () => void;
  continueFallback: () => void;
  stopRelayMode: () => void;
  markCompleted: () => void;
};

export function attachSenderSignalHandler(context: SenderSignalHandlerContext): void {
  context.ws.addEventListener("message", async (event) => {
    const message = parseSignalMessage(event);
    if (!message || context.isStopped()) return;
    if (message.type === "receiver-ready") {
      context.handleReceiverReady(message.payload);
      return;
    }
    if (message.type === "answer") {
      const pc = context.getPeerConnection();
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
      const pc = context.getPeerConnection();
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
      applyMode(message.payload.mode, context.handlers);
      if (message.payload.mode === "relay") {
        context.markDirectFailed();
        context.continueFallback();
      }
      return;
    }
    if (message.type === "relay-ready") {
      context.markDirectFailed();
      context.continueFallback();
      return;
    }
    if (message.type === "relay-message") {
      sendSignal(context.ws, {
        type: "relay-ack",
        payload: { sequence: message.payload.sequence },
      });
      const transferMessage = fromRelayMessage(message.payload.message);
      if (transferMessage.type === "chunk-commit") {
        context.queue.commit(transferMessage);
      }
      return;
    }
    if (message.type === "relay-ack") {
      context.queue.acknowledge(message.payload.sequence);
      context.stopRelayMode();
      return;
    }
    if (message.type === "transfer-complete") {
      context.markCompleted();
    }
  });
}
