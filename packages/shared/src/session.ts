import { z } from "zod";

export const APP_NAME = "P2P File";

export const TransferModeSchema = z.enum(["direct", "relay"]);

export const FileManifestItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const SessionIdSchema = z.string().min(6);

export const ClaimRequestSchema = z.object({
  sessionId: SessionIdSchema,
  receiverToken: z.string().min(1).optional(),
});

export const AppStatusSchema = z.object({
  ok: z.literal(true),
  service: z.enum(["signal"]),
  product: z.literal(APP_NAME),
});

export const SignalEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session:claim"),
    payload: ClaimRequestSchema,
  }),
  z.object({
    type: z.literal("session:mode"),
    payload: z.object({
      sessionId: SessionIdSchema,
      mode: TransferModeSchema,
    }),
  }),
]);

export type TransferMode = z.infer<typeof TransferModeSchema>;
export type FileManifestItem = z.infer<typeof FileManifestItemSchema>;
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export type AppStatus = z.infer<typeof AppStatusSchema>;
export type SignalEnvelope = z.infer<typeof SignalEnvelopeSchema>;
