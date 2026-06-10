import { afterEach, expect, test } from "bun:test";
import { loadReceiverSession, type ReceiveSessionLoaderContext } from "./receive-flow-loader";
import type { ReceiverStage } from "./receive-flow-utils";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const signalSessionPayload = (state: "claimed" | "failed") => ({
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

const stubResponses = (responses: unknown[]) => {
  let call = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
};

const createContext = () => {
  const stages: ReceiverStage[] = [];
  const statuses: string[] = [];
  const retries: Array<number | null> = [];
  const context: ReceiveSessionLoaderContext = {
    navigate() {},
    setSession() {},
    setProgress() {},
    setMode() {},
    setStage(stage) {
      stages.push(stage);
    },
    setStatus(status) {
      statuses.push(status);
    },
    setError() {},
    setRetriesRemaining(value) {
      retries.push(value);
    },
  };
  return { context, stages, statuses, retries };
};

test("visitor loading a failed session gets retry-exhausted guidance", async () => {
  stubResponses([signalSessionPayload("failed")]);
  const { context, stages, statuses } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(stages.at(-1)).toBe("retry-exhausted");
  expect(statuses.at(-1)).toContain("请发送方重新创建会话");
});

test("original receiver re-entry surfaces the remaining retry budget", async () => {
  stubResponses([
    signalSessionPayload("claimed"),
    {
      status: "claimed",
      receiverToken: "receiver-token-receiver-token",
      retriesRemaining: 1,
      session: signalSessionPayload("claimed"),
    },
  ]);
  const { context, retries } = createContext();

  await loadReceiverSession("abcdefabcdef", false, context);

  expect(retries.at(-1)).toBe(1);
});
