import { expect, test } from "bun:test";
import { decideFallbackStep } from "./fallback-policy";

test("no direct failure keeps the direct attempt regardless of TURN state", () => {
  expect(
    decideFallbackStep({
      directFailed: false,
      turnConfigured: true,
      turnAttempted: false,
      wsRelayFailed: false,
    }),
  ).toBe("direct-retry");
});

test("direct failure with unattempted TURN configuration chooses the turn step", () => {
  expect(
    decideFallbackStep({
      directFailed: true,
      turnConfigured: true,
      turnAttempted: false,
      wsRelayFailed: false,
    }),
  ).toBe("turn");
});

test("direct failure without TURN configuration falls back to ws-relay", () => {
  expect(
    decideFallbackStep({
      directFailed: true,
      turnConfigured: false,
      turnAttempted: false,
      wsRelayFailed: false,
    }),
  ).toBe("ws-relay");
});

test("direct failure after a failed TURN attempt falls back to ws-relay", () => {
  expect(
    decideFallbackStep({
      directFailed: true,
      turnConfigured: true,
      turnAttempted: true,
      wsRelayFailed: false,
    }),
  ).toBe("ws-relay");
});

test("ws-relay failure after a failed TURN attempt fails the transfer", () => {
  expect(
    decideFallbackStep({
      directFailed: true,
      turnConfigured: true,
      turnAttempted: true,
      wsRelayFailed: true,
    }),
  ).toBe("fail");
});

test("ws-relay failure without TURN configuration fails the transfer", () => {
  expect(
    decideFallbackStep({
      directFailed: true,
      turnConfigured: false,
      turnAttempted: false,
      wsRelayFailed: true,
    }),
  ).toBe("fail");
});

test("ws-relay failure still tries an unattempted TURN configuration first", () => {
  expect(
    decideFallbackStep({
      directFailed: true,
      turnConfigured: true,
      turnAttempted: false,
      wsRelayFailed: true,
    }),
  ).toBe("turn");
});
