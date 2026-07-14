import type { RelayMessageQueue } from "./relay-queue";
import { fromRelayMessage } from "./relay-runtime";
import { applyMode, parseSignalWire, sendSignal } from "./runtime-shared";
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
  startRelayTransfer: () => void;
  stopRelayMode: () => void;
  markCompleted: () => void;
};

export function attachSenderSignalHandler(context: SenderSignalHandlerContext): void {
  const pendingIceCandidates: Array<{
    pc: RTCPeerConnection;
    candidate: RTCIceCandidateInit;
  }> = [];

  const applyPendingIceCandidates = async (pc: RTCPeerConnection) => {
    while (pendingIceCandidates.length > 0) {
      const pending = pendingIceCandidates.shift();
      if (!pending || pending.pc !== pc) continue;
      try {
        await pc.addIceCandidate(pending.candidate);
      } catch {
        // Ignore a candidate from a superseded offer.
      }
    }
  };

  context.ws.addEventListener("message", async (event) => {
    if (context.isStopped()) return;
    const wire = parseSignalWire(event);
    if (!wire) return;

    if (wire.kind === "binary-relay-chunk") {
      // Binary relay currently carries file chunks sender->receiver only.
      // Receiver->sender binary is reserved for future commit frames.
      return;
    }

    const message = wire.message;
    if (message.type === "receiver-ready") {
      context.handleReceiverReady(message.payload);
      return;
    }
    if (message.type === "answer") {
      const pc = context.getPeerConnection();
      if (pc && pc.remoteDescription === null) {
        try {
          await pc.setRemoteDescription(message.payload);
          await applyPendingIceCandidates(pc);
        } catch {
          // Ignore stale answers from a superseded offer.
        }
      }
      return;
    }
    if (message.type === "ice-candidate") {
      const pc = context.getPeerConnection();
      if (pc) {
        if (pc.remoteDescription === null) {
          pendingIceCandidates.push({ pc, candidate: message.payload });
          return;
        }
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
      }
      return;
    }
    if (message.type === "relay-ready") {
      context.markDirectFailed();
      context.startRelayTransfer();
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
    if (message.type === "relay-nack") {
      context.queue.nack(message.payload.sequence, message.payload.reason ?? "peer-unavailable");
      return;
    }
    if (message.type === "transfer-complete") {
      context.markCompleted();
    }
  });
}
