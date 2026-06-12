import { afterEach, expect, test } from "bun:test";
import { claimSession, completeSession, releaseSession } from "./runtime";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const sessionPayload = (state: "claimed" | "failed") => ({
  sessionId: "abcdefabcdef",
  state,
  manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  summary: { fileCount: 1, totalSize: 128 },
  transferMode: "direct",
  canClaim: false,
  claimed: state === "claimed",
  completed: false,
  ended: false,
  expiresAt: null,
  retriesRemaining: 2,
});

const stubClaimResponse = (body: unknown) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
};

test("claimSession surfaces retriesRemaining from a claimed response", async () => {
  stubClaimResponse({
    status: "claimed",
    receiverToken: "receiver-token-receiver-token",
    retriesRemaining: 2,
    session: sessionPayload("claimed"),
  });

  const result = await claimSession("abcdefabcdef");

  expect(result.claim).toBe("claimed");
  expect(result.retriesRemaining).toBe(2);
});

test("claimSession maps a retry-budget-exhausted response to the failed claim state", async () => {
  stubClaimResponse({
    status: "failed",
    session: { ...sessionPayload("failed"), failureReason: "retry-budget-exhausted" },
  });

  const result = await claimSession("abcdefabcdef");

  expect(result.claim).toBe("failed");
  expect(result.session.status).toBe("failed");
  expect(result.session.failureReason).toBe("retry-budget-exhausted");
  expect(result.retriesRemaining).toBeNull();
});

test("releaseSession returns invalid-token 2xx responses instead of treating them as released", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: "invalid-token",
        session: sessionPayload("claimed"),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch;

  const result = await releaseSession("abcdefabcdef", "receiver-token-receiver-token");

  expect(result.release).toBe("invalid-token");
  expect(result.session.status).toBe("claimed");
});

test("completeSession sends Receiver Token and full-manifest integrity proof", async () => {
  let requestBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await completeSession(
    "abcdefabcdef",
    "receiver-token-receiver-token",
    [{ id: "file-1", bytes: 128 }],
    128,
  );

  expect(JSON.parse(requestBody)).toEqual({
    receiverToken: "receiver-token-receiver-token",
    completedFiles: [{ id: "file-1", bytes: 128 }],
    totalBytes: 128,
  });
});
