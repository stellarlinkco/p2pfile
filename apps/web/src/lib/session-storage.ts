const RECEIVER_TOKEN_PREFIX = "p2pfile:receiver:";

export function readReceiverToken(sessionId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(`${RECEIVER_TOKEN_PREFIX}${sessionId}`);
}

export function writeReceiverToken(sessionId: string, receiverToken: string) {
  window.localStorage.setItem(`${RECEIVER_TOKEN_PREFIX}${sessionId}`, receiverToken);
}

export function clearReceiverToken(sessionId: string) {
  window.localStorage.removeItem(`${RECEIVER_TOKEN_PREFIX}${sessionId}`);
}
