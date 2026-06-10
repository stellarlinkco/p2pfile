import { ClaimSessionResponseSchema } from "@p2pfile/shared";
import type { StoredSession } from "./session-model";
import { toPublicSession } from "./session-view";

export function terminalClaimResponse(session: StoredSession, receiverToken?: string) {
  if (session.state === "failed") {
    return ClaimSessionResponseSchema.parse({
      status: "failed",
      session: toPublicSession(session),
    });
  }
  if (session.state === "ended") {
    return ClaimSessionResponseSchema.parse({ status: "ended", session: toPublicSession(session) });
  }
  if (session.state === "completed-view") {
    return ClaimSessionResponseSchema.parse({
      status: "completed",
      originalReceiver: Boolean(receiverToken && receiverToken === session.receiverToken),
      session: toPublicSession(session),
    });
  }
  return null;
}
