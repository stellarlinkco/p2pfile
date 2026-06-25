import type { StoredSession } from "./session-model";

const ACTIVE_SESSION_STATE: Record<
  "claimed" | "connecting" | "transferring" | "reconnecting",
  true
> = {
  claimed: true,
  connecting: true,
  transferring: true,
  reconnecting: true,
};

export const isActiveSessionState = (state: StoredSession["state"]) =>
  state in ACTIVE_SESSION_STATE;

export const markConnecting = (session: StoredSession) => {
  if (session.state === "claimed") session.state = "connecting";
};

export const markTransferring = (session: StoredSession) => {
  if (session.state === "claimed" || session.state === "connecting") session.state = "transferring";
};
