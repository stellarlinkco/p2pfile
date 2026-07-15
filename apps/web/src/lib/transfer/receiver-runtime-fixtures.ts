import type { BrowserSignalMessage } from "./types";

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;
  private readonly listeners = new Map<string, Array<(event: RTCDataChannelEvent) => void>>();

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addEventListener(type: string, listener: (event: RTCDataChannelEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchDataChannel(channel: RTCDataChannel) {
    const event = { channel } as RTCDataChannelEvent;
    for (const listener of this.listeners.get("datachannel") ?? []) {
      listener(event);
    }
  }

  getStats = async () => new Map() as unknown as RTCStatsReport;
  close() {}
  async setRemoteDescription() {}
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0 fake-answer" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = { ...description, toJSON: () => description } as RTCSessionDescription;
  }
  async addIceCandidate() {}
}

export class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType: BinaryType = "blob";
  sent: BrowserSignalMessage[] = [];
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as BrowserSignalMessage);
  }

  dispatchMessage(message: BrowserSignalMessage) {
    const event = { data: JSON.stringify(message) } as MessageEvent<string>;
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }

  dispatchBlob(frame: ArrayBuffer) {
    const event = { data: new Blob([frame]) } as MessageEvent;
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }

  close(reason = "") {
    for (const listener of this.listeners.get("close") ?? []) {
      listener({ reason } as unknown as MessageEvent);
    }
  }
}
