import {
  type FileManifestItem,
  SessionIdSchema,
  SessionPublicViewSchema,
  type TransferMode,
  TransferModeSchema,
} from "@p2pfile/shared";
import type {
  ClaimSessionResponse,
  ClaimSessionState,
  CreateSessionResponse,
  SessionPublicView,
  SignalRole,
} from "./types";

const CLAIM_STATES: Record<ClaimSessionState, true> = {
  claimed: true,
  occupied: true,
  completed: true,
  ended: true,
  failed: true,
};

function requestOrigin() {
  if (typeof window === "undefined") {
    return "http://127.0.0.1:3001";
  }

  const configuredOrigin = import.meta.env?.VITE_SIGNAL_ORIGIN;
  if (typeof configuredOrigin === "string" && configuredOrigin.length > 0) {
    return configuredOrigin;
  }

  const url = new URL(window.location.origin);
  if (url.port === "4173") {
    url.port = "3001";
  }

  return url.origin;
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSharePath(value: unknown, sessionId: string) {
  const sharePath = asString(value);
  return sharePath.length > 0 ? sharePath : `/f/${sessionId}`;
}

function normalizeTransferMode(value: unknown, fallback: TransferMode) {
  if (value == null) {
    return fallback;
  }

  return TransferModeSchema.parse(value);
}

function normalizeSession(value: unknown) {
  const object = asObject(value);
  if (!object) {
    throw new Error("Session payload is missing.");
  }

  const parsed = SessionPublicViewSchema.parse(object);
  const sessionId = parsed.sessionId;
  const files = parsed.manifest;
  const fileCount = parsed.summary.fileCount;
  const totalBytes = parsed.summary.totalSize;
  const accessCode = asString(object.accessCode);
  const sharePath = normalizeSharePath(object.sharePath, sessionId);

  return {
    ...parsed,
    accessCode,
    sharePath,
    status: parsed.state,
    files,
    fileCount,
    totalBytes,
    transferMode: normalizeTransferMode(object.transferMode, parsed.transferMode),
    claimedAt: null,
    completedAt: parsed.completed ? new Date().toISOString() : null,
    endedAt: parsed.ended ? new Date().toISOString() : null,
    expiresAt: asOptionalNumber(parsed.expiresAt),
  } satisfies SessionPublicView;
}

async function parseJson(response: Response) {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Unexpected response: ${text}`);
  }
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${requestOrigin()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await parseJson(response);

  if (!response.ok) {
    const message = asObject(payload)?.message;
    throw new Error(
      typeof message === "string" && message.length > 0
        ? message
        : `Request failed (${response.status}).`,
    );
  }

  return payload;
}

export function getApiOrigin() {
  return requestOrigin();
}

export function getWsOrigin() {
  const url = new URL(requestOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function buildShareUrl(sharePath: string) {
  const normalizedPath = sharePath.startsWith("/") ? sharePath : `/${sharePath}`;
  return new URL(normalizedPath, window.location.origin).toString();
}

export async function createSession(manifest: FileManifestItem[]) {
  const payload = asObject(
    await requestJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ manifest }),
    }),
  );
  if (!payload) {
    throw new Error("Session creation response is invalid.");
  }

  const session = normalizeSession(payload.session ?? payload);
  const accessCode = asString(payload.accessCode, session.accessCode);
  const sharePath = normalizeSharePath(payload.sharePath ?? session.sharePath, session.sessionId);

  return {
    sessionId: SessionIdSchema.parse(asString(payload.sessionId, session.sessionId)),
    accessCode,
    sharePath,
    senderToken: asString(payload.senderToken),
    expiresAt: asOptionalNumber(payload.expiresAt ?? session.expiresAt),
    session: {
      ...session,
      accessCode,
      sharePath,
    },
  } satisfies CreateSessionResponse;
}

export async function getSession(sessionId: string) {
  return normalizeSession(await requestJson(`/api/sessions/${sessionId}`));
}

export async function claimSession(sessionId: string, receiverToken?: string | null) {
  const payload = asObject(
    await requestJson(`/api/sessions/${sessionId}/claim`, {
      method: "POST",
      body: JSON.stringify(receiverToken ? { receiverToken } : {}),
    }),
  );
  if (!payload) {
    throw new Error("Claim response is invalid.");
  }

  const claim = asString(payload.claim ?? payload.status);
  if (!(claim in CLAIM_STATES)) {
    throw new Error("Claim response is missing a valid state.");
  }

  const session = normalizeSession(payload.session ?? payload);
  return {
    ok: true,
    session,
    receiverToken: asOptionalString(payload.receiverToken),
    retriesRemaining: asOptionalNumber(payload.retriesRemaining),
    originalReceiver: Boolean(payload.originalReceiver),
    claim: claim as ClaimSessionState,
  } satisfies ClaimSessionResponse;
}

export async function releaseSession(sessionId: string, receiverToken: string) {
  await requestJson(`/api/sessions/${sessionId}/release`, {
    method: "POST",
    body: JSON.stringify({ receiverToken }),
  });
}

export async function completeSession(sessionId: string, receiverToken: string) {
  await requestJson(`/api/sessions/${sessionId}/complete`, {
    method: "POST",
    body: JSON.stringify({ receiverToken }),
  });
}

export async function endSession(sessionId: string, senderToken: string, keepalive = false) {
  await requestJson(`/api/sessions/${sessionId}/end`, {
    method: "POST",
    body: JSON.stringify({ senderToken }),
    keepalive,
  });
}

export function sendEndSessionBeacon(sessionId: string, senderToken: string) {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }

  return navigator.sendBeacon(
    `${requestOrigin()}/api/sessions/${sessionId}/end`,
    new Blob([JSON.stringify({ senderToken })], {
      type: "application/json",
    }),
  );
}

export async function resolveAccessCode(accessCode: string) {
  const payload = asObject(
    await requestJson(`/api/access-codes/${encodeURIComponent(accessCode)}`),
  );
  if (!payload) {
    throw new Error("Access code response is invalid.");
  }

  const sessionId = SessionIdSchema.parse(asString(payload.sessionId));
  return {
    sessionId,
    sharePath: normalizeSharePath(payload.sharePath, sessionId),
  };
}

export function getSignalUrl(sessionId: string, role: SignalRole, token: string) {
  return `${getWsOrigin()}/ws/${encodeURIComponent(sessionId)}/${role}/${encodeURIComponent(token)}`;
}
