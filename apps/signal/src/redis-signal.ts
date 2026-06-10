import { type SignalEnvelope, SignalEnvelopeSchema } from "@p2pfile/shared";

export function parseSignalEnvelope(rawMessage: string): SignalEnvelope | null {
  try {
    const parsed = SignalEnvelopeSchema.safeParse(JSON.parse(rawMessage));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
