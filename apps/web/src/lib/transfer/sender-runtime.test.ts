import { expect, test } from "bun:test";
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
  sent: string[] = [];
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
    if (typeof data === "string") {
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
