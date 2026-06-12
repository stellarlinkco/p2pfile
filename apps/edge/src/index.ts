import { handleApi, handleWebSocket } from "./api";
import { resetEdgeNowForTests, setEdgeNowForTests as setNowForTests } from "./clock";
import type { EdgeEnv } from "./env";

export type { EdgeEnv } from "./env";
export { SessionDirectory } from "./session-directory";
export { SessionDurableObject } from "./session-durable-object";

export async function handleRequest(request: Request, env: EdgeEnv) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
  if (url.pathname.startsWith("/ws/")) return handleWebSocket(request, env, url);
  return env.ASSETS.fetch(request);
}

export function resetEdgeSessionsForTests() {
  resetEdgeNowForTests();
}

export function setEdgeNowForTests(now: () => number) {
  setNowForTests(now);
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<EdgeEnv>;
