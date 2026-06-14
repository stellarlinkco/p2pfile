import { expect, test } from "bun:test";
import { resumeProgressFromManifest } from "@p2pfile/shared";
import { createApp } from "./app";
import { LiveSessionStore } from "./runtime";

const createJsonRequest = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createSession = async (app: ReturnType<typeof createApp>["app"]) => {
  const response = await app.request(
    createJsonRequest("POST", "/api/sessions", {
      manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
    }),
  );
  return response.json();
};

test("visitor session view moves a waiting session to viewing without losing claimability", async () => {
  const { app } = createApp();
  const created = await createSession(app);

  const firstView = await app.request(`http://localhost/api/sessions/${created.sessionId}`);
  const firstBody = await firstView.json();
  const secondView = await app.request(`http://localhost/api/sessions/${created.sessionId}`);
  const secondBody = await secondView.json();

  expect(created.session.state).toBe("waiting");
  expect(firstBody.state).toBe("viewing");
  expect(firstBody.canClaim).toBe(true);
  expect(firstBody.expiresAt).toBe(created.session.expiresAt);
  expect(secondBody.state).toBe("viewing");
});

test("a viewing session can still be claimed by any visitor", async () => {
  const { app } = createApp();
  const created = await createSession(app);
  await app.request(`http://localhost/api/sessions/${created.sessionId}`);

  const claim = await app.request(
    createJsonRequest("POST", `/api/sessions/${created.sessionId}/claim`, {}),
  );
  const claimBody = await claim.json();

  expect(claimBody.status).toBe("claimed");
  expect(claimBody.session.state).toBe("claimed");
  expect(claimBody.receiverToken.length).toBeGreaterThan(16);
});

test("active signaling moves claimed sessions through connecting and transferring", () => {
  const store = new LiveSessionStore();
  const created = store.createSession({
    manifest: [{ id: "file-1", name: "hello.txt", size: 128 }],
  });
  const claim = store.claimSession(created.sessionId);
  if (claim?.status !== "claimed") {
    throw new Error("expected claimed");
  }

  const offered = store.handleSignal(
    created.sessionId,
    "sender",
    created.senderToken,
    JSON.stringify({
      type: "offer",
      payload: { type: "offer", sdp: "v=0" },
    }),
  );
  const connecting = store.getPublicSession(created.sessionId);
  expect(offered).toBe(true);
  expect(connecting?.state).toBe("connecting");
  expect(connecting?.claimed).toBe(true);
  expect(connecting?.canClaim).toBe(false);
  expect(store.claimSession(created.sessionId)?.status).toBe("occupied");

  const ready = store.handleSignal(
    created.sessionId,
    "receiver",
    claim.receiverToken,
    JSON.stringify({
      type: "receiver-ready",
      payload: {
        completedFiles: 0,
        progress: resumeProgressFromManifest([{ id: "file-1", name: "hello.txt", size: 128 }]),
      },
    }),
  );
  const transferring = store.getPublicSession(created.sessionId);
  expect(ready).toBe(true);
  expect(transferring?.state).toBe("transferring");
  expect(transferring?.claimed).toBe(true);
  expect(transferring?.canClaim).toBe(false);

  const release = store.releaseSession(created.sessionId, { receiverToken: claim.receiverToken });
  expect(release?.session.state).toBe("waiting");
  expect(release?.session.canClaim).toBe(true);
});
