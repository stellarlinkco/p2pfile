import { z } from "zod";

export const APP_NAME = "P2P File";
export const SENDER_RECONNECT_GRACE_MS = 30 * 1000;

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
export const SessionStateSchema = z.enum([
  "waiting",
  "viewing",
  "claimed",
  "connecting",
  "transferring",
  "completed-view",
  "reconnecting",
  "ended",
  "failed",
]);

export const FileManifestItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).optional(),
});

export const FrozenManifestSchema = z.array(FileManifestItemSchema).min(1);
export const MANIFEST_CHUNK_BYTES = 64 * 1024;

export function manifestHash(files: Array<{ id: string; name: string; size: number }>) {
  return files.map((file) => `${file.id}:${file.name}:${file.size}`).join("|");
}

export const ResumeProgressFileSchema = z.object({
  fileId: z.string().min(1),
  size: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  committedBytes: z.number().int().nonnegative(),
  completed: z.boolean(),
});

export const ResumeProgressSchema = z
  .object({
    manifestHash: z.string().min(1),
    files: z.array(ResumeProgressFileSchema).min(1),
  })
  .superRefine((progress, context) => {
    for (const [index, file] of progress.files.entries()) {
      if (file.committedBytes > file.size) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "committedBytes"],
          message: "Committed bytes must not exceed file size.",
        });
      }
      if (
        file.completed !== (file.committedBytes === file.size && (file.size > 0 || file.completed))
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "completed"],
          message: "Completed must match committed bytes.",
        });
      }
      if (file.committedBytes !== file.size && file.committedBytes % file.chunkSize !== 0) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "committedBytes"],
          message: "Committed bytes must align to chunk boundaries.",
        });
      }
    }
  });

export const TransferChunkSchema = z.object({
  type: z.literal("chunk"),
  fileId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  bytes: z.instanceof(ArrayBuffer),
  chunkDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const ChunkCommitAckSchema = z.object({
  type: z.literal("chunk-commit"),
  fileId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  committedBytes: z.number().int().nonnegative(),
});

export function resumeProgressFromManifest(
  files: Array<{ id: string; name: string; size: number }>,
  committedBytesByFileId: ReadonlyMap<string, number> = new Map(),
) {
  return ResumeProgressSchema.parse({
    manifestHash: manifestHash(files),
    files: files.map((file) => {
      const committedBytes = Math.max(
        0,
        Math.min(committedBytesByFileId.get(file.id) ?? 0, file.size),
      );
      return {
        fileId: file.id,
        size: file.size,
        chunkSize: MANIFEST_CHUNK_BYTES,
        committedBytes,
        completed:
          committedBytes === file.size && (file.size > 0 || committedBytesByFileId.has(file.id)),
      };
    }),
  });
}

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
  retriesRemaining: z.number().int().nonnegative(),
  failureReason: z.string().min(1).optional(),
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

export const DEFAULT_RETRY_BUDGET = 3;

export const ClaimSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("claimed"),
    receiverToken: SessionTokenSchema,
    retriesRemaining: z.number().int().nonnegative(),
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
  z.object({
    status: z.literal("failed"),
    session: SessionPublicViewSchema,
  }),
]);

export const ReleaseSessionRequestSchema = z.object({
  receiverToken: SessionTokenSchema,
});

export const ReleaseSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("released"),
    session: SessionPublicViewSchema,
  }),
  z.object({
    status: z.literal("invalid-token"),
    session: SessionPublicViewSchema,
  }),
]);

const CompletedManifestItemSchema = z.object({
  id: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export const CompleteSessionRequestSchema = z.object({
  receiverToken: SessionTokenSchema,
  completedFiles: z.array(CompletedManifestItemSchema).min(1),
  totalBytes: z.number().int().nonnegative(),
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
  progress: ResumeProgressSchema,
  completedFiles: z.number().int().nonnegative().optional(),
  receiverInstanceId: z.string().min(1).optional(),
});

const RTCSessionDescriptionPayloadSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1),
});

const ChunkCommitAckMessageSchema = ChunkCommitAckSchema;
const RelayProtocolMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manifest"),
    files: z.array(FileManifestItemSchema).min(1),
    totalBytes: z.number().int().nonnegative(),
    manifestHash: z.string().min(1),
  }),
  z.object({
    type: z.literal("file-start"),
    file: FileManifestItemSchema,
    offset: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("chunk"),
    fileId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1),
    chunkDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  ChunkCommitAckMessageSchema,
  z.object({
    type: z.literal("file-end"),
    fileId: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    type: z.literal("complete"),
    totalBytes: z.number().int().nonnegative(),
  }),
]);

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
      candidate: z.string(),
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
    type: z.literal("sender-reconnecting"),
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
      message: RelayProtocolMessageSchema,
    }),
  }),
  z.object({
    type: z.literal("relay-ack"),
    payload: z.object({
      sequence: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("relay-nack"),
    payload: z.object({
      sequence: z.number().int().nonnegative(),
      reason: z.string().min(1).optional(),
    }),
  }),
  z.object({
    type: z.literal("transfer-complete"),
    payload: ReceiverCompletedStatusSchema,
  }),
]);
export const DirectSignalEnvelopeSchema = SignalEnvelopeSchema.refine(
  (envelope) =>
    envelope.type === "offer" ||
    envelope.type === "answer" ||
    envelope.type === "ice-candidate" ||
    envelope.type === "receiver-ready" ||
    envelope.type === "mode",
);

export type TransferMode = z.infer<typeof TransferModeSchema>;
export type DirectSignalEnvelope = z.infer<typeof DirectSignalEnvelopeSchema>;
export type SessionRole = z.infer<typeof SessionRoleSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type FileManifestItem = z.infer<typeof FileManifestItemSchema>;
export type FrozenManifest = z.infer<typeof FrozenManifestSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionPublicView = z.infer<typeof SessionPublicViewSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type ReleaseSessionResponse = z.infer<typeof ReleaseSessionResponseSchema>;
export type ClaimSessionRequest = z.infer<typeof ClaimSessionRequestSchema>;
export type ClaimSessionResponse = z.infer<typeof ClaimSessionResponseSchema>;
export type ReleaseSessionRequest = z.infer<typeof ReleaseSessionRequestSchema>;
export type CompleteSessionRequest = z.infer<typeof CompleteSessionRequestSchema>;
export type EndSessionRequest = z.infer<typeof EndSessionRequestSchema>;
export type SessionMutationResponse = z.infer<typeof SessionMutationResponseSchema>;
export type AccessCodeResolveResponse = z.infer<typeof AccessCodeResolveResponseSchema>;
export type AppStatus = z.infer<typeof AppStatusSchema>;
export type SenderHeartbeat = z.infer<typeof SenderHeartbeatSchema>;
export type ResumeProgress = z.infer<typeof ResumeProgressSchema>;
export type TransferChunk = z.infer<typeof TransferChunkSchema>;
export type ChunkCommitAck = z.infer<typeof ChunkCommitAckSchema>;
export type ReceiverCompletedStatus = z.infer<typeof ReceiverCompletedStatusSchema>;
export type SignalEnvelope = z.infer<typeof SignalEnvelopeSchema>;
