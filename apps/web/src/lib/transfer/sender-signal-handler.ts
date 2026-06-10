import type { RelayMessageQueue } from "./relay-queue";
import { applyMode, parseSignalMessage } from "./runtime-shared";
import type { SenderRuntimeHandlers } from "./types";

type SenderSignalHandlerContext = {
  ws: WebSocket;
  queue: RelayMessageQueue;
  handlers: SenderRuntimeHandlers;
  isStopped: () => boolean;
  getPeerConnection: () => RTCPeerConnection | null;
  handleReceiverReady: (completedFiles: number) => void;
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
      context.handleReceiverReady(message.payload.completedFiles);
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
