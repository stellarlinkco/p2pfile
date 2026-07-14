import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { decodeBinaryRelayChunkFrame } from "./relay-runtime";
import { shouldReuseDirectAttempt, startSenderRuntime } from "./sender-runtime";
import type { BrowserSignalMessage, SenderRuntimeHandlers } from "./types";

test("sender retry does not reuse a closed data channel", () => {
  const peer = { signalingState: "stable" } as RTCPeerConnection;
  const closedChannel = { readyState: "closed" } as RTCDataChannel;

  expect(shouldReuseDirectAttempt(peer, closedChannel)).toBe(false);
});

test("sender retry can reuse a connecting data channel", () => {
  const peer = { signalingState: "stable" } as RTCPeerConnection;
  const connectingChannel = { readyState: "connecting" } as RTCDataChannel;

  expect(shouldReuseDirectAttempt(peer, connectingChannel)).toBe(true);
});

class FakeDataChannel {
  binaryType = "blob";
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  failNextBinarySend = false;
  sent: string[] = [];
  sentBinaryFrames = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    if (this.readyState !== "open") {
      throw new DOMException(
        "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
        "InvalidStateError",
      );
    }
    if (data instanceof ArrayBuffer) {
      if (this.failNextBinarySend) {
        this.readyState = "closed";
        this.failNextBinarySend = false;
        throw new DOMException(
          "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
          "InvalidStateError",
        );
      }
      this.sentBinaryFrames += 1;
      return;
    }
    if (typeof data === "string") {
      if (
        this.failNextBinarySend &&
        (data.includes('"type":"chunk"') || data.includes('"bytesBase64"'))
      ) {
        this.readyState = "closed";
        this.failNextBinarySend = false;
        throw new DOMException(
          "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
          "InvalidStateError",
        );
      }
      this.sent.push(data);
    }
  }

  close() {
    this.readyState = "closed";
  }

  open() {
    this.readyState = "open";
    for (const listener of this.listeners.get("open") ?? []) {
      listener();
    }
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  readonly config: RTCConfiguration;
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channels: FakeDataChannel[] = [];
  addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  createDataChannel() {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0 fake-offer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = {
      ...description,
      toJSON: () => description,
    } as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.remoteDescription === null) throw new Error("Remote description is not set.");
    this.addedCandidates.push(candidate);
  }

  close() {
    this.closed = true;
    this.signalingState = "closed";
    this.connectionState = "closed";
  }

  failIce() {
    this.iceConnectionState = "failed";
    this.connectionState = "failed";
    for (const listener of this.listeners.get("iceconnectionstatechange") ?? []) {
      listener();
    }
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: Array<BrowserSignalMessage | ArrayBuffer> = [];
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") {
      this.sent.push(JSON.parse(data) as BrowserSignalMessage);
      return;
    }
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) {
      listener({} as MessageEvent<string>);
    }
  }

  receive(message: BrowserSignalMessage) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) } as MessageEvent<string>);
    }
  }

  relayMessageCount() {
    return (
      this.sent.filter(
        (message) =>
          typeof message !== "string" &&
          !(message instanceof ArrayBuffer) &&
          message.type === "relay-message",
      ).length + this.sent.filter((message) => message instanceof ArrayBuffer).length
    );
  }
}

type SenderHarness = {
  handlers: SenderRuntimeHandlers;
  modes: string[];
  errors: string[];
  socket: () => FakeWebSocket;
  peer: (index: number) => FakePeerConnection;
  settle: () => Promise<void>;
};

async function withSenderHarness(
  turnUrl: string | undefined,
  run: (harness: SenderHarness) => Promise<void>,
) {
  const previousTurnUrl = process.env.VITE_TURN_URL;
  const previousPeerConnection = globalThis.RTCPeerConnection;
  const previousWebSocket = globalThis.WebSocket;
  if (turnUrl === undefined) {
    delete process.env.VITE_TURN_URL;
  } else {
    process.env.VITE_TURN_URL = turnUrl;
  }
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const modes: string[] = [];
  const errors: string[] = [];
  const handlers: SenderRuntimeHandlers = {
    onStatus() {},
    onMode(mode) {
      modes.push(mode);
    },
    onProgress() {},
    onComplete() {},
    onError(message) {
      errors.push(message);
    },
  };

  try {
    await run({
      handlers,
      modes,
      errors,
      socket: () => {
        const socket = FakeWebSocket.instances[0];
        if (!socket) throw new Error("Signal socket was not created.");
        return socket;
      },
      peer: (index: number) => {
        const peer = FakePeerConnection.instances[index];
        if (!peer) throw new Error(`Peer connection ${index} was not created.`);
        return peer;
      },
      settle: async () => {
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
        }
        await Bun.sleep(0);
      },
    });
  } finally {
    globalThis.RTCPeerConnection = previousPeerConnection;
    globalThis.WebSocket = previousWebSocket;
    if (previousTurnUrl === undefined) {
      delete process.env.VITE_TURN_URL;
    } else {
      process.env.VITE_TURN_URL = previousTurnUrl;
    }
  }
}

test("direct ICE failure with TURN configured renegotiates via a relay-only attempt before ws relay", async () => {
  await withSenderHarness(
    "turn:turn.example.com:3478",
    async ({ handlers, socket, peer, settle }) => {
      const runtime = await startSenderRuntime("session-1", "sender-token", [], [], handlers);
      await settle();
      expect(FakePeerConnection.instances.length).toBe(1);

      peer(0).failIce();
      await settle();

      expect(FakePeerConnection.instances.length).toBe(2);
      expect(peer(1).config.iceTransportPolicy).toBe("relay");
      expect(socket().relayMessageCount()).toBe(0);
      const offers = socket().sent.filter(
        (message): message is BrowserSignalMessage & { type: "offer" } =>
          typeof message !== "string" &&
          !(message instanceof ArrayBuffer) &&
          message.type === "offer",
      );
      expect(offers.length).toBe(2);

      runtime.stop();
    },
  );
});

test("sender applies ICE candidates received before the answer", async () => {
  await withSenderHarness(undefined, async ({ handlers, socket, peer, settle }) => {
    const runtime = await startSenderRuntime(
      "session-candidate-order",
      "sender-token",
      [],
      [],
      handlers,
    );
    const candidate = {
      candidate: "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };

    socket().receive({ type: "ice-candidate", payload: candidate });
    socket().receive({ type: "answer", payload: { type: "answer", sdp: "v=0" } });
    await settle();

    expect(peer(0).addedCandidates).toEqual([candidate]);
    runtime.stop();
  });
});

test("TURN relay-only failure falls through to ws relay", async () => {
  await withSenderHarness(
    "turn:turn.example.com:3478",
    async ({ handlers, socket, peer, settle }) => {
      const runtime = await startSenderRuntime(
        "session-turn-fails",
        "sender-token",
        [],
        [],
        handlers,
      );
      await settle();

      peer(0).failIce();
      await settle();
      expect(FakePeerConnection.instances.length).toBe(2);
      expect(socket().relayMessageCount()).toBe(0);

      peer(1).failIce();
      await settle();
      expect(socket().relayMessageCount()).toBe(0);
      socket().receive({ type: "relay-ready", payload: {} });
      await settle();

      expect(socket().relayMessageCount()).toBeGreaterThan(0);

      runtime.stop();
    },
  );
});

test("TURN relay data channel announces relay mode", async () => {
  await withSenderHarness(
    "turn:turn.example.com:3478",
    async ({ handlers, socket, peer, settle }) => {
      const runtime = await startSenderRuntime(
        "session-turn-open",
        "sender-token",
        [],
        [],
        handlers,
      );
      await settle();
      peer(0).failIce();
      await settle();

      peer(1).channels[0]?.open();
      await settle();

      expect(socket().sent).toContainEqual({ type: "mode", payload: { mode: "relay" } });

      runtime.stop();
    },
  );
});

test("direct ICE failure without TURN keeps existing ws relay fallback", async () => {
  await withSenderHarness(undefined, async ({ handlers, socket, peer, settle }) => {
    const runtime = await startSenderRuntime("session-2", "sender-token", [], [], handlers);
    await settle();
    expect(FakePeerConnection.instances.length).toBe(1);

    peer(0).failIce();
    await settle();

    expect(FakePeerConnection.instances.length).toBe(1);
    expect(socket().relayMessageCount()).toBe(0);

    socket().receive({ type: "relay-ready", payload: {} });
    await settle();
    expect(socket().relayMessageCount()).toBeGreaterThan(0);

    runtime.stop();
  });
});

test("receiver replacement nack waits for fresh relay readiness", async () => {
  await withSenderHarness(undefined, async ({ handlers, errors, socket, peer, settle }) => {
    const runtime = await startSenderRuntime(
      "session-relay-nack",
      "sender-token",
      [],
      [],
      handlers,
    );
    await settle();
    peer(0).failIce();
    socket().receive({ type: "relay-ready", payload: {} });
    await settle();
    const sentBeforeRestart = socket().relayMessageCount();
    expect(sentBeforeRestart).toBeGreaterThan(0);

    socket().receive({ type: "relay-nack", payload: { sequence: 0, reason: "peer-unavailable" } });
    await settle();
    expect(errors).toEqual([]);

    socket().receive({ type: "relay-ready", payload: {} });
    await settle();
    expect(socket().relayMessageCount()).toBeGreaterThan(sentBeforeRestart);
    runtime.stop();
  });
});

test("accidental signal socket close reattaches sender with the same token", async () => {
  await withSenderHarness(undefined, async ({ settle }) => {
    const runtime = await startSenderRuntime("session-reconnect", "sender-token", [], [], {
      onStatus() {},
      onMode() {},
      onProgress() {},
      onComplete() {},
      onError() {},
    });
    await settle();

    const firstSocket = FakeWebSocket.instances[0];
    if (!firstSocket) throw new Error("expected first signal socket");
    firstSocket.close();
    await settle();

    const secondSocket = FakeWebSocket.instances[1];
    if (!secondSocket) throw new Error("expected reattached signal socket");
    expect(secondSocket.url).toContain("/ws/session-reconnect/sender/sender-token");
    expect(FakePeerConnection.instances.length).toBeGreaterThanOrEqual(2);

    runtime.stop();
  });
});
test("signal socket close during an active direct large transfer keeps the data channel alive", async () => {
  await withSenderHarness(undefined, async ({ handlers, socket, peer, settle }) => {
    const file = new File([new Uint8Array(MANIFEST_CHUNK_BYTES * 2)], "large.zip", {
      type: "application/zip",
    });
    const manifest = [{ id: "file-1", name: file.name, size: file.size, mimeType: file.type }];
    const runtime = await startSenderRuntime(
      "session-active-direct",
      "sender-token",
      [file],
      manifest,
      handlers,
    );
    await settle();
    const channel = peer(0).channels[0];
    if (!channel) throw new Error("Expected direct data channel.");
    peer(0).iceConnectionState = "connected";
    channel.open();
    await settle();

    socket().close();
    await settle();

    expect(channel.readyState).toBe("open");
    expect(FakePeerConnection.instances).toHaveLength(1);
    runtime.stop();
  });
});

test("signal socket close rebuilds direct transport when ICE already failed", async () => {
  await withSenderHarness(undefined, async ({ handlers, socket, peer, settle }) => {
    const file = new File([new Uint8Array(MANIFEST_CHUNK_BYTES * 2)], "large.zip", {
      type: "application/zip",
    });
    const manifest = [{ id: "file-1", name: file.name, size: file.size, mimeType: file.type }];
    const runtime = await startSenderRuntime(
      "session-failed-ice",
      "sender-token",
      [file],
      manifest,
      handlers,
    );
    await settle();
    const channel = peer(0).channels[0];
    if (!channel) throw new Error("Expected direct data channel.");
    channel.open();
    peer(0).iceConnectionState = "failed";
    peer(0).connectionState = "failed";
    await settle();

    socket().close();
    await settle();

    expect(channel.readyState).toBe("closed");
    expect(FakePeerConnection.instances).toHaveLength(2);
    runtime.stop();
  });
});

test("data channel close during a zip send waits for receiver-ready instead of ws relay", async () => {
  await withSenderHarness(undefined, async ({ errors, socket, peer, settle }) => {
    const file = {
      name: "archive-1000g.zip",
      size: 1000 * 1024 ** 3,
      type: "application/zip",
      slice() {
        return new Blob([new Uint8Array(64 * 1024)], { type: "application/zip" });
      },
    } as unknown as File;
    const manifest = [{ id: "file-1", name: file.name, size: file.size, mimeType: file.type }];
    const runtime = await startSenderRuntime(
      "session-large-zip",
      "sender-token",
      [file],
      manifest,
      {
        onStatus() {},
        onMode() {},
        onProgress() {},
        onComplete() {},
        onError(message) {
          errors.push(message);
        },
      },
    );
    await settle();
    const channel = peer(0).channels[0];
    if (!channel) throw new Error("Expected direct data channel.");
    channel.failNextBinarySend = true;
    channel.open();
    await Bun.sleep(20);
    await settle();

    // Receiver reload closes the DataChannel mid-send. That must not force WS relay;
    // recovery is owned by the next receiver-ready / ICE failure path.
    expect(socket().relayMessageCount()).toBe(0);
    expect(errors).toEqual([]);

    socket().receive({
      type: "receiver-ready",
      payload: {
        progress: {
          manifestHash: `${manifest[0]?.id}:${manifest[0]?.name}:${manifest[0]?.size}`,
          files: [
            {
              fileId: "file-1",
              size: file.size,
              chunkSize: MANIFEST_CHUNK_BYTES,
              committedBytes: 0,
              completed: false,
            },
          ],
        },
        receiverInstanceId: "receiver-after-reload",
      },
    });
    await settle();
    expect(FakePeerConnection.instances.length).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    runtime.stop();
  });
});
test("relay signal reconnect waits for fresh receiver progress before resending", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __P2PFILE_TEST_FALLBACK__: true, location: { origin: "http://localhost" } },
  });

  try {
    await withSenderHarness(undefined, async ({ handlers, settle }) => {
      const file = new File([new Uint8Array(MANIFEST_CHUNK_BYTES * 2)], "large.zip", {
        type: "application/zip",
      });
      const manifest = [{ id: "file-1", name: file.name, size: file.size, mimeType: file.type }];
      const runtime = await startSenderRuntime(
        "session-relay-signal-reconnect",
        "sender-token",
        [file],
        manifest,
        handlers,
      );
      await settle();

      const firstSocket = FakeWebSocket.instances[0];
      if (!firstSocket) throw new Error("Expected initial signal socket.");
      firstSocket.receive({
        type: "receiver-ready",
        payload: {
          progress: {
            manifestHash: `${manifest[0]?.id}:${manifest[0]?.name}:${manifest[0]?.size}`,
            files: [
              {
                fileId: "file-1",
                size: file.size,
                chunkSize: MANIFEST_CHUNK_BYTES,
                committedBytes: 0,
                completed: false,
              },
            ],
          },
          receiverInstanceId: "receiver-a",
        },
      });
      firstSocket.receive({ type: "relay-ready", payload: {} });
      await settle();
      expect(firstSocket.relayMessageCount()).toBeGreaterThan(0);

      firstSocket.close();
      await settle();
      const replacement = FakeWebSocket.instances[1];
      if (!replacement) throw new Error("Expected replacement signal socket.");
      expect(replacement.relayMessageCount()).toBe(0);

      runtime.stop();
    });
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("receiver restart resets an in-flight relay transfer when progress is unchanged", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __P2PFILE_TEST_FALLBACK__: true, location: { origin: "http://localhost" } },
  });

  try {
    await withSenderHarness(undefined, async ({ errors, socket, settle }) => {
      const file = new File([new Uint8Array(MANIFEST_CHUNK_BYTES * 2)], "large.zip", {
        type: "application/zip",
      });
      const manifest = [{ id: "file-1", name: file.name, size: file.size, mimeType: file.type }];
      const manifestFile = manifest[0];
      if (!manifestFile) throw new Error("Expected manifest item.");
      const runtime = await startSenderRuntime(
        "session-relay-restart",
        "sender-token",
        [file],
        manifest,
        {
          onStatus() {},
          onMode() {},
          onProgress() {},
          onComplete() {},
          onError(message) {
            errors.push(message);
          },
        },
      );
      await settle();

      const progress = {
        manifestHash: `${manifestFile.id}:${manifestFile.name}:${manifestFile.size}`,
        files: [
          {
            fileId: manifestFile.id,
            size: manifestFile.size,
            chunkSize: MANIFEST_CHUNK_BYTES,
            committedBytes: MANIFEST_CHUNK_BYTES,
            completed: false,
          },
        ],
      };
      const acknowledged = new Set<BrowserSignalMessage | ArrayBuffer>();
      const acknowledgeRelayMessages = async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          for (const message of socket().sent) {
            if (message instanceof ArrayBuffer) {
              if (acknowledged.has(message)) continue;
              acknowledged.add(message);
              const decoded = decodeBinaryRelayChunkFrame(message);
              if (decoded) {
                socket().receive({
                  type: "relay-ack",
                  payload: { sequence: decoded.sequence },
                });
              }
              continue;
            }
            if (message.type !== "relay-message" || acknowledged.has(message)) continue;
            acknowledged.add(message);
            socket().receive({
              type: "relay-ack",
              payload: { sequence: message.payload.sequence },
            });
          }
          await settle();
        }
      };
      const relayFileStarts = () =>
        socket().sent.flatMap((message) =>
          typeof message !== "string" &&
          !(message instanceof ArrayBuffer) &&
          message.type === "relay-message" &&
          message.payload.message.type === "file-start"
            ? [message.payload.message.offset]
            : [],
        );

      socket().receive({
        type: "receiver-ready",
        payload: { progress, receiverInstanceId: "receiver-a" },
      });
      socket().receive({ type: "relay-ready", payload: {} });
      await acknowledgeRelayMessages();
      expect(relayFileStarts()).toEqual([MANIFEST_CHUNK_BYTES]);

      socket().receive({
        type: "receiver-ready",
        payload: { progress, receiverInstanceId: "receiver-b" },
      });
      socket().receive({ type: "relay-ready", payload: {} });
      await acknowledgeRelayMessages();

      let lastChunkFileId: string | null = null;
      let lastChunkIndex: number | null = null;
      for (const message of socket().sent) {
        if (message instanceof ArrayBuffer) {
          const decoded = decodeBinaryRelayChunkFrame(message);
          if (decoded) {
            lastChunkFileId = decoded.message.fileId;
            lastChunkIndex = decoded.message.chunkIndex;
          }
          continue;
        }
        if (
          typeof message !== "string" &&
          message.type === "relay-message" &&
          message.payload.message.type === "chunk"
        ) {
          lastChunkFileId = message.payload.message.fileId;
          lastChunkIndex = message.payload.message.chunkIndex;
        }
      }
      if (lastChunkFileId !== null && lastChunkIndex !== null) {
        socket().receive({
          type: "relay-message",
          payload: {
            sequence: 1000,
            message: {
              type: "chunk-commit",
              fileId: lastChunkFileId,
              chunkIndex: lastChunkIndex,
              committedBytes: MANIFEST_CHUNK_BYTES * 2,
            },
          },
        });
        await settle();
      }
      expect(relayFileStarts()).toEqual([MANIFEST_CHUNK_BYTES, MANIFEST_CHUNK_BYTES]);
      expect(errors).toEqual([]);
      runtime.stop();
    });
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
