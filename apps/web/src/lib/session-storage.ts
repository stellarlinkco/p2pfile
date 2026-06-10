const RECEIVER_TOKEN_PREFIX = "p2pfile:receiver:";
const receiverTokenMemory = new Map<string, string>();

function receiverTokenKey(sessionId: string) {
  return `${RECEIVER_TOKEN_PREFIX}${sessionId}`;
}

export function readReceiverToken(sessionId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const memoryToken = receiverTokenMemory.get(sessionId);
  if (memoryToken) {
    return memoryToken;
  }

  try {
    const storedToken = window.localStorage.getItem(receiverTokenKey(sessionId));
    if (storedToken) {
      receiverTokenMemory.set(sessionId, storedToken);
    }
    return storedToken;
  } catch {
    return null;
  }
}

export function writeReceiverToken(sessionId: string, receiverToken: string) {
  receiverTokenMemory.set(sessionId, receiverToken);
  try {
    window.localStorage.setItem(receiverTokenKey(sessionId), receiverToken);
  } catch {
    // Best-effort cache only.
  }
}

export function clearReceiverToken(sessionId: string) {
  receiverTokenMemory.delete(sessionId);
  try {
    window.localStorage.removeItem(receiverTokenKey(sessionId));
  } catch {
    // Best-effort cache only.
  }
}
