import { expect, test } from "bun:test";
import {
  awaitBufferedAmount,
  collectTransportDiagnostics,
  pumpDataChannelSend,
} from "./runtime-shared";

test("awaitBufferedAmount rejects when channel closes before draining", async () => {
  const listeners = new Map<string, Set<() => void>>();
  const channel = {
    bufferedAmount: 2 * 1024 * 1024,
    bufferedAmountLowThreshold: 0,
    readyState: "open",
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as RTCDataChannel;

  const pending = awaitBufferedAmount(channel);
  for (const listener of listeners.get("close") ?? []) {
    listener();
  }

  await expect(pending).rejects.toThrow("Data channel is not open.");
});

test("awaitBufferedAmount resolves when the buffer is already drained before the listener attaches", async () => {
  let bufferedAmount = 2 * 1024 * 1024;
  const channel = {
    get bufferedAmount() {
      return bufferedAmount;
    },
    bufferedAmountLowThreshold: 0,
    readyState: "open",
    addEventListener(type: string) {
      // Simulate a race: the browser drains the buffer before the listener is registered,
      // so bufferedamountlow never fires again.
      if (type === "bufferedamountlow") {
        bufferedAmount = 0;
      }
    },
    removeEventListener() {},
  } as unknown as RTCDataChannel;

  await expect(awaitBufferedAmount(channel)).resolves.toBeUndefined();
});

test("pumpDataChannelSend sends first then waits only under high water mark", async () => {
  let bufferedAmount = 0;
  const sent: ArrayBuffer[] = [];
  const channel = {
    get bufferedAmount() {
      return bufferedAmount;
    },
    bufferedAmountLowThreshold: 0,
    readyState: "open",
    send(data: ArrayBuffer) {
      sent.push(data);
      bufferedAmount += data.byteLength;
    },
    addEventListener(type: string, listener: () => void) {
      if (type === "bufferedamountlow") {
        bufferedAmount = 0;
        listener();
      }
    },
    removeEventListener() {},
  } as unknown as RTCDataChannel;

  const payload = new ArrayBuffer(64 * 1024);
  // Below high-water mark: send succeeds and does not need to drain.
  await pumpDataChannelSend(channel, payload);
  expect(sent).toHaveLength(1);
  expect(bufferedAmount).toBe(64 * 1024);

  // Force above high-water mark so the pump waits for bufferedamountlow.
  bufferedAmount = 2 * 1024 * 1024;
  await pumpDataChannelSend(channel, payload);
  expect(sent).toHaveLength(2);
  expect(bufferedAmount).toBe(0);
});

test("collectTransportDiagnostics reports selected candidate types when present", async () => {
  const pc = {
    async getStats() {
      const map = new Map<string, RTCStats>();
      map.set("pair-1", {
        id: "pair-1",
        type: "candidate-pair",
        timestamp: 0,
        selected: true,
        localCandidateId: "local-1",
        remoteCandidateId: "remote-1",
      } as RTCStats & {
        selected: boolean;
        localCandidateId: string;
        remoteCandidateId: string;
      });
      map.set("local-1", {
        id: "local-1",
        type: "local-candidate",
        timestamp: 0,
        candidateType: "host",
        protocol: "udp",
      } as RTCStats & { candidateType: string; protocol: string });
      map.set("remote-1", {
        id: "remote-1",
        type: "remote-candidate",
        timestamp: 0,
        candidateType: "srflx",
        protocol: "udp",
      } as RTCStats & { candidateType: string; protocol: string });
      return map as unknown as RTCStatsReport;
    },
  } as RTCPeerConnection;

  await expect(collectTransportDiagnostics(pc, "direct")).resolves.toEqual({
    mode: "direct",
    localCandidateType: "host",
    remoteCandidateType: "srflx",
    protocol: "udp",
    iceTransportPolicy: null,
  });
});
