import { type SessionRole, type SignalEnvelope, SignalEnvelopeSchema } from "@p2pfile/shared";

export function parseDirectSignal(data: unknown): SignalEnvelope | null {
  if (typeof data !== "string") return null;
  try {
    const envelope = SignalEnvelopeSchema.safeParse(JSON.parse(data));
    return envelope.success ? envelope.data : null;
  } catch {
    return null;
  }
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
