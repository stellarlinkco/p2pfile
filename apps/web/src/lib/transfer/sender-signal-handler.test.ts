import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
import { attachSenderSignalHandler } from "./sender-signal-handler";
import type { BrowserSignalMessage, SenderRuntimeHandlers } from "./types";

const handlers: SenderRuntimeHandlers = {
  onStatus() {},
  onMode() {},
  onProgress() {},
  onComplete() {},
  onError() {},
};

class FakeSignalSocket {
  readyState = WebSocket.OPEN;
  sent: BrowserSignalMessage[] = [];
  private readonly listeners = new Set<(event: MessageEvent) => void | Promise<void>>();

  addEventListener(type: string, listener: (event: MessageEvent) => void | Promise<void>) {
    if (type === "message") this.listeners.add(listener);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.sent.push(JSON.parse(data) as BrowserSignalMessage);
  }

  receive(message: BrowserSignalMessage) {
    for (const listener of this.listeners) {
      listener({ data: JSON.stringify(message) } as MessageEvent<string>);
    }
  }

  async receiveBlob(message: BrowserSignalMessage) {
    const data = new Blob([JSON.stringify(message)], { type: "application/json" });
    await Promise.all(
      [...this.listeners].map((listener) => listener({ data } as MessageEvent<Blob>)),
    );
  }
}

function attach(
  ws: FakeSignalSocket,
  queue: RelayMessageQueue,
  overrides: Partial<{
    getPeerConnection: () => RTCPeerConnection | null;
    handleReceiverReady: () => void;
    markDirectFailed: () => void;
    startRelayTransfer: () => void;
  }> = {},
) {
  attachSenderSignalHandler({
    ws: ws as unknown as WebSocket,
    queue,
    handlers,
    isStopped: () => false,
    getPeerConnection: overrides.getPeerConnection ?? (() => null),
    handleReceiverReady: overrides.handleReceiverReady ?? (() => undefined),
    markDirectFailed: overrides.markDirectFailed ?? (() => undefined),
    startRelayTransfer: overrides.startRelayTransfer ?? (() => undefined),
    stopRelayMode() {},
    markCompleted() {},
  });
}

test("sender treats inbound relay chunk-commit as receiver commit and sends only transport relay ack", async () => {
  const ws = new FakeSignalSocket();
  const queue = new RelayMessageQueue(() => undefined);
  const commit = queue.awaitCommit("file-1", 0, MANIFEST_CHUNK_BYTES);

  try {
    attach(ws, queue);
    ws.receive({
      type: "relay-message",
      payload: {
        sequence: 9,
        message: {
          type: "chunk-commit",
          fileId: "file-1",
          chunkIndex: 0,
          committedBytes: MANIFEST_CHUNK_BYTES,
        },
      },
    });

    await expect(commit).resolves.toBe(MANIFEST_CHUNK_BYTES);
    expect(ws.sent).toEqual([{ type: "relay-ack", payload: { sequence: 9 } }]);
  } finally {
    queue.stop();
  }
});

test("sender parses JSON signaling delivered as a Blob", async () => {
  const ws = new FakeSignalSocket();
  const queue = new RelayMessageQueue(() => undefined);
  let receiverReady = false;

  try {
    attach(ws, queue, { handleReceiverReady: () => (receiverReady = true) });
    await ws.receiveBlob({
      type: "receiver-ready",
      payload: { progress: { manifestHash: "", files: [] } },
    });
    expect(receiverReady).toBe(true);
  } finally {
    queue.stop();
  }
});

test("sender queues ICE candidates received before the answer", async () => {
  const ws = new FakeSignalSocket();
  const queue = new RelayMessageQueue(() => undefined);
  let remoteDescription: RTCSessionDescriptionInit | null = null;
  const addedCandidates: RTCIceCandidateInit[] = [];
  const peer = {
    get remoteDescription() {
      return remoteDescription;
    },
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      remoteDescription = description;
    },
    async addIceCandidate(candidate: RTCIceCandidateInit) {
      if (remoteDescription === null) throw new Error("Remote description is not set.");
      addedCandidates.push(candidate);
    },
  } as RTCPeerConnection;

  try {
    attach(ws, queue, { getPeerConnection: () => peer });
    const candidate = {
      candidate: "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    ws.receive({ type: "ice-candidate", payload: candidate });
    ws.receive({ type: "answer", payload: { type: "answer", sdp: "v=0" } });
    await Bun.sleep(0);
    expect(addedCandidates).toEqual([candidate]);
  } finally {
    queue.stop();
  }
});

test("sender nack rejects the matching relay sequence without waiting for ack timeout", async () => {
  const ws = new FakeSignalSocket();
  const queue = new RelayMessageQueue(() => undefined, { ackTimeoutMs: 60_000 });
  const pending = queue.send({ type: "complete", totalBytes: 1 });

  try {
    attach(ws, queue);
    ws.receive({
      type: "relay-nack",
      payload: { sequence: 0, reason: "peer-unavailable" },
    });
    await expect(pending).rejects.toThrow("Relay peer unavailable.");
  } finally {
    queue.stop();
  }
});

test("sender waits for relay-ready before starting fallback transfer", () => {
  const ws = new FakeSignalSocket();
  const queue = new RelayMessageQueue(() => undefined);
  let directFailures = 0;
  let relayStarts = 0;

  try {
    attach(ws, queue, {
      markDirectFailed: () => {
        directFailures += 1;
      },
      startRelayTransfer: () => {
        relayStarts += 1;
      },
    });
    ws.receive({ type: "mode", payload: { mode: "relay" } });
    expect(directFailures).toBe(1);
    expect(relayStarts).toBe(0);
    ws.receive({ type: "relay-ready", payload: {} });
    expect(directFailures).toBe(2);
    expect(relayStarts).toBe(1);
  } finally {
    queue.stop();
  }
});
