import { z } from "zod";

export const APP_NAME = "P2P File";

export const SessionIdSchema = z.string().min(6);
export const SessionAccessCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{6}$/);
export const SessionTokenSchema = z.string().min(16);
export const SharePathSchema = z.string().startsWith("/");

export const TransferModeSchema = z.enum(["direct", "relay"]);
export const SessionRoleSchema = z.enum(["sender", "receiver"]);
export const SessionStateSchema = z.enum(["waiting", "claimed", "completed-view", "ended"]);

export const FileManifestItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).optional(),
});

export const FrozenManifestSchema = z.array(FileManifestItemSchema).min(1);

export const CreateSessionRequestSchema = z.object({
  manifest: FrozenManifestSchema,
});

export const SessionSummarySchema = z.object({
  fileCount: z.number().int().positive(),
  totalSize: z.number().int().nonnegative(),
});

export const SessionPublicViewSchema = z.object({
  sessionId: SessionIdSchema,
  state: SessionStateSchema,
  manifest: FrozenManifestSchema,
  summary: SessionSummarySchema,
  transferMode: TransferModeSchema,
  canClaim: z.boolean(),
  claimed: z.boolean(),
  completed: z.boolean(),
  ended: z.boolean(),
  expiresAt: z.number().int().nonnegative().nullable(),
});

export const CreateSessionResponseSchema = z.object({
  sessionId: SessionIdSchema,
  accessCode: SessionAccessCodeSchema,
  sharePath: SharePathSchema,
  senderToken: SessionTokenSchema,
  session: SessionPublicViewSchema,
});

export const ClaimSessionRequestSchema = z.object({
  receiverToken: SessionTokenSchema.optional(),
});

export const ClaimSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("claimed"),
    receiverToken: SessionTokenSchema,
    session: SessionPublicViewSchema,
  }),
  z.object({
    status: z.literal("occupied"),
    session: SessionPublicViewSchema,
  }),
  z.object({
    status: z.literal("completed"),
    originalReceiver: z.boolean(),
    session: SessionPublicViewSchema,
  }),
  z.object({
    status: z.literal("ended"),
    session: SessionPublicViewSchema,
  }),
]);

export const ReleaseSessionRequestSchema = z.object({
  receiverToken: SessionTokenSchema,
});

export const CompleteSessionRequestSchema = z.object({
  receiverToken: SessionTokenSchema,
});

export const EndSessionRequestSchema = z.object({
  senderToken: SessionTokenSchema,
});

export const SessionMutationResponseSchema = z.object({
  ok: z.literal(true),
  session: SessionPublicViewSchema,
});

export const AccessCodeResolveResponseSchema = z.object({
  sessionId: SessionIdSchema,
  sharePath: SharePathSchema,
});

export const AppStatusSchema = z.object({
  ok: z.literal(true),
  service: z.literal("signal"),
  product: z.literal(APP_NAME),
});

export const SenderHeartbeatSchema = z.object({
  sentAt: z.number().int().nonnegative().optional(),
});

export const ReceiverCompletedStatusSchema = z.object({
  completedAt: z.number().int().nonnegative().optional(),
});

export const ReceiverReadyStatusSchema = z.object({
  completedFiles: z.number().int().nonnegative(),
});

const RTCSessionDescriptionPayloadSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1),
});

export const SignalEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("offer"),
    payload: RTCSessionDescriptionPayloadSchema.extend({
      type: z.literal("offer"),
    }),
  }),
  z.object({
    type: z.literal("answer"),
    payload: RTCSessionDescriptionPayloadSchema.extend({
      type: z.literal("answer"),
    }),
  }),
  z.object({
    type: z.literal("ice-candidate"),
    payload: z.object({
      candidate: z.string().min(1),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("mode"),
    payload: z.object({
      mode: TransferModeSchema,
    }),
  }),
  z.object({
    type: z.literal("sender-heartbeat"),
    payload: SenderHeartbeatSchema,
  }),
  z.object({
    type: z.literal("receiver-ready"),
    payload: ReceiverReadyStatusSchema,
  }),
  z.object({
    type: z.literal("sender-left"),
    payload: z.object({
      reason: z.string().min(1).optional(),
    }),
  }),
  z.object({
    type: z.literal("relay-ready"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("relay-message"),
    payload: z.object({
      sequence: z.number().int().nonnegative(),
      message: z.unknown(),
    }),
  }),
  z.object({
    type: z.literal("relay-ack"),
    payload: z.object({
      sequence: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("transfer-complete"),
    payload: ReceiverCompletedStatusSchema,
  }),
]);

export type TransferMode = z.infer<typeof TransferModeSchema>;
export type SessionRole = z.infer<typeof SessionRoleSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type FileManifestItem = z.infer<typeof FileManifestItemSchema>;
export type FrozenManifest = z.infer<typeof FrozenManifestSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionPublicView = z.infer<typeof SessionPublicViewSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type ClaimSessionRequest = z.infer<typeof ClaimSessionRequestSchema>;
export type ClaimSessionResponse = z.infer<typeof ClaimSessionResponseSchema>;
export type ReleaseSessionRequest = z.infer<typeof ReleaseSessionRequestSchema>;
export type CompleteSessionRequest = z.infer<typeof CompleteSessionRequestSchema>;
export type EndSessionRequest = z.infer<typeof EndSessionRequestSchema>;
export type SessionMutationResponse = z.infer<typeof SessionMutationResponseSchema>;
export type AccessCodeResolveResponse = z.infer<typeof AccessCodeResolveResponseSchema>;
export type AppStatus = z.infer<typeof AppStatusSchema>;
export type SenderHeartbeat = z.infer<typeof SenderHeartbeatSchema>;
export type ReceiverCompletedStatus = z.infer<typeof ReceiverCompletedStatusSchema>;
export type SignalEnvelope = z.infer<typeof SignalEnvelopeSchema>;
