import { type SessionRole, type SignalEnvelope, SignalEnvelopeSchema } from "@p2pfile/shared";

export type ParsedEdgeWire =
  | { kind: "json"; envelope: SignalEnvelope }
  | { kind: "binary"; bytes: ArrayBuffer };

export function parseDirectSignal(data: unknown): SignalEnvelope | null {
  if (typeof data !== "string") return null;
  try {
    const envelope = SignalEnvelopeSchema.safeParse(JSON.parse(data));
    return envelope.success ? envelope.data : null;
  } catch {
    return null;
  }
}

export function parseEdgeWire(data: unknown): ParsedEdgeWire | null {
  if (typeof data === "string") {
    const envelope = parseDirectSignal(data);
    return envelope ? { kind: "json", envelope } : null;
  }
  if (data instanceof ArrayBuffer) {
    return { kind: "binary", bytes: data };
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return { kind: "binary", bytes: copy.buffer };
  }
  return null;
}

export function isRoleAllowedSignal(role: SessionRole, envelope: SignalEnvelope) {
  if (envelope.type === "mode" || envelope.type === "ice-candidate") return true;
  if (role === "sender") {
    return (
      envelope.type === "offer" ||
      envelope.type === "sender-left" ||
      envelope.type === "relay-message"
    );
  }
  return (
    envelope.type === "answer" ||
    envelope.type === "receiver-ready" ||
    envelope.type === "relay-ready" ||
    envelope.type === "relay-ack"
  );
}

export function closeSockets(sockets: Partial<Record<SessionRole, WebSocket>>) {
  sockets.sender?.close(1000, "session closed");
  sockets.receiver?.close(1000, "session closed");
  delete sockets.sender;
  delete sockets.receiver;
}
