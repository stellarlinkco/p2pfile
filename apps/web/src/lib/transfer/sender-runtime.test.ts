import { expect, test } from "bun:test";
import { MANIFEST_CHUNK_BYTES } from "@p2pfile/shared";
import { RelayMessageQueue } from "./relay-queue";
import { shouldReuseDirectAttempt, startSenderRuntime } from "./sender-runtime";
import { attachSenderSignalHandler } from "./sender-signal-handler";
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

test("sender treats inbound relay chunk-commit as receiver commit and sends only transport relay ack", async () => {
  const ws = new FakeWebSocket("ws://sender");
  const queue = new RelayMessageQueue(() => undefined);
  const commit = queue.awaitCommit("file-1", 0, MANIFEST_CHUNK_BYTES);

  try {
    attachSenderSignalHandler({
      ws: ws as unknown as WebSocket,
      queue,
      handlers: {
        onStatus() {},
        onMode() {},
        onProgress() {},
        onComplete() {},
        onError() {},
      },
      isStopped: () => false,
      getPeerConnection: () => null,
      handleReceiverReady() {},
      markDirectFailed() {},
      continueFallback() {},
      stopRelayMode() {},
      markCompleted() {},
    });

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
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channels: FakeDataChannel[] = [];
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

  async addIceCandidate() {}

  close() {
    this.closed = true;
    this.signalingState = "closed";
  }

  failIce() {
    this.iceConnectionState = "failed";
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
  sent: BrowserSignalMessage[] = [];
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as BrowserSignalMessage);
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
    return this.sent.filter((message) => message.type === "relay-message").length;
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
      const offers = socket().sent.filter((message) => message.type === "offer");
      expect(offers.length).toBe(2);

      runtime.stop();
    },
  );
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
    expect(socket().relayMessageCount()).toBeGreaterThan(0);

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

test("data channel close during a zip send falls back to ws relay", async () => {
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

    expect(socket().relayMessageCount()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    runtime.stop();
  });
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
      const acknowledged = new Set<BrowserSignalMessage>();
      const acknowledgeRelayMessages = async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          for (const message of socket().sent) {
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
          message.type === "relay-message" && message.payload.message.type === "file-start"
            ? [message.payload.message.offset]
            : [],
        );

      socket().receive({
        type: "receiver-ready",
        payload: { progress, receiverInstanceId: "receiver-a" },
      });
      await acknowledgeRelayMessages();
      expect(relayFileStarts()).toEqual([MANIFEST_CHUNK_BYTES]);

      socket().receive({
        type: "receiver-ready",
        payload: { progress, receiverInstanceId: "receiver-b" },
      });
      await acknowledgeRelayMessages();

      const lastChunk = socket()
        .sent.filter(
          (message): message is BrowserSignalMessage & { type: "relay-message" } =>
            message.type === "relay-message" && message.payload.message.type === "chunk",
        )
        .at(-1);
      if (lastChunk?.payload.message.type === "chunk") {
        socket().receive({
          type: "relay-message",
          payload: {
            sequence: 1000,
            message: {
              type: "chunk-commit",
              fileId: lastChunk.payload.message.fileId,
              chunkIndex: lastChunk.payload.message.chunkIndex,
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
