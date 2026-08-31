import { z } from "zod"
import { PROTOCOL_VERSION } from "./version.ts"

export const RoleSchema = z.enum(["viewer", "approver", "owner"])
export type Role = z.infer<typeof RoleSchema>

export const LocationSchema = z.object({
  directory: z.string().min(1).max(4096),
  workspace: z.string().min(1).max(512).optional(),
})
export type Location = z.infer<typeof LocationSchema>

export const CapabilitiesSchema = z.object({
  permissionReply: z.boolean(),
  savedPermission: z.boolean(),
  questionReply: z.boolean(),
  questionReject: z.boolean(),
  sessionExecutionEvents: z.boolean(),
  pendingSync: z.boolean(),
  workspaceRouting: z.boolean(),
  locationRouting: z.boolean(),
  sessionHierarchy: z.boolean(),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

export const TuiMetadataSchema = z.object({
  instanceId: z.string().min(8).max(160),
  sessionId: z.string().max(256).optional(),
  rootSessionId: z.string().max(256).optional(),
  parentSessionId: z.string().max(256).optional(),
  project: z.string().max(512),
  projectId: z.string().max(256).optional(),
  directory: z.string().max(4096),
  worktree: z.string().max(4096).optional(),
  branch: z.string().max(512).optional(),
  tmux: z.string().max(256).optional(),
  sessionTitle: z.string().max(512).optional(),
  agent: z.string().max(256).optional(),
  model: z.string().max(256).optional(),
  pid: z.number().int().positive(),
  hostname: z.string().max(256),
  opencodeVersion: z.string().max(64),
  pluginVersion: z.string().max(64),
  startedAt: z.number().int().nonnegative(),
  location: LocationSchema,
  capabilities: CapabilitiesSchema,
})
export type TuiMetadata = z.infer<typeof TuiMetadataSchema>

const BaseEventSchema = z.object({
  eventId: z.string().min(8).max(160),
  emittedAt: z.number().int().nonnegative(),
  instanceId: z.string().min(8).max(160),
  sessionId: z.string().max(256).optional(),
  rootSessionId: z.string().max(256).optional(),
  location: LocationSchema,
  context: z
    .object({
      host: z.string().max(256).optional(),
      project: z.string().max(512).optional(),
      branch: z.string().max(512).optional(),
      tmux: z.string().max(256).optional(),
      title: z.string().max(512).optional(),
      agent: z.string().max(256).optional(),
      model: z.string().max(256).optional(),
    })
    .optional(),
})

const PermissionSchema = BaseEventSchema.extend({
  type: z.literal("permission.asked"),
  requestId: z.string().min(1).max(256),
  action: z.string().min(1).max(256),
  patterns: z.array(z.string().max(8192)).max(64),
  always: z.array(z.string().max(8192)).max(64),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const QuestionOptionSchema = z.object({
  label: z.string().min(1).max(512),
  description: z.string().max(2048).optional(),
})

const QuestionSchema = z.object({
  header: z.string().max(128),
  question: z.string().min(1).max(8192),
  options: z.array(QuestionOptionSchema).max(64),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
})

const QuestionAskedSchema = BaseEventSchema.extend({
  type: z.literal("question.asked"),
  requestId: z.string().min(1).max(256),
  questions: z.array(QuestionSchema).min(1).max(32),
})

const ResolvedSchema = BaseEventSchema.extend({
  type: z.literal("request.resolved"),
  requestId: z.string().min(1).max(256),
  requestKind: z.enum(["permission", "question"]),
  resolution: z.enum(["once", "always", "reject", "answered", "cancelled", "stale"]),
  source: z.enum(["telegram", "tui", "opencode", "reconcile"]),
})

const ExecutionSchema = BaseEventSchema.extend({
  type: z.enum(["execution.started", "execution.succeeded", "execution.failed", "execution.stuck"]),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().max(4096).optional(),
  finalPreview: z.string().max(1024).optional(),
})

const TuiDisconnectedSchema = BaseEventSchema.extend({
  type: z.literal("tui.disconnected"),
})

const ReconcileSchema = BaseEventSchema.extend({
  type: z.literal("reconcile"),
  metadata: TuiMetadataSchema,
  pendingPermissions: z.array(PermissionSchema).max(256),
  pendingQuestions: z.array(QuestionAskedSchema).max(256),
  scopeSessionIds: z.array(z.string().max(256)).max(256),
})

export const BridgeEventSchema = z.discriminatedUnion("type", [
  PermissionSchema,
  QuestionAskedSchema,
  ResolvedSchema,
  ExecutionSchema,
  TuiDisconnectedSchema,
  ReconcileSchema,
])
export type BridgeEvent = z.infer<typeof BridgeEventSchema>
export type PermissionAsked = z.infer<typeof PermissionSchema>
export type QuestionAsked = z.infer<typeof QuestionAskedSchema>

export const LocalRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("register"), metadata: TuiMetadataSchema }),
  z.object({ type: z.literal("unregister"), instanceId: z.string().min(8).max(160) }),
  z.object({ type: z.literal("event"), event: BridgeEventSchema }),
  z.object({
    type: z.literal("action.result"),
    actionId: z.string().min(8).max(160),
    ok: z.boolean(),
    state: z.enum(["confirmed", "failed", "stale"]),
    detail: z.string().max(2048).optional(),
    evidence: z
      .object({ repliedEvent: z.boolean(), pendingAbsent: z.boolean(), executionObserved: z.boolean() })
      .optional(),
  }),
])
export type LocalRequest = z.infer<typeof LocalRequestSchema>

export const ActionDispatchSchema = z.object({
  type: z.literal("action.dispatch"),
  actionId: z.string().min(8).max(160),
  instanceId: z.string().min(8).max(160),
  sessionId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  requestKind: z.enum(["permission", "question"]),
  operation: z.enum(["once", "always", "reject", "answer", "cancel"]),
  message: z.string().max(4096).optional(),
  answers: z
    .array(z.array(z.string().max(4096)).max(64))
    .max(32)
    .optional(),
  location: LocationSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
})
export type ActionDispatch = z.infer<typeof ActionDispatchSchema>

export const NodeToHubSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    nodeId: z.string().min(8).max(160),
    nodeName: z.string().min(1).max(256),
    hostname: z.string().min(1).max(256),
    version: z.string().max(64),
    lastAck: z.number().int().nonnegative(),
    generation: z.string().min(8).max(160),
  }),
  z.object({
    type: z.literal("event"),
    generation: z.string().min(8).max(160),
    seq: z.number().int().positive(),
    event: BridgeEventSchema,
  }),
  z.object({
    type: z.literal("action.result"),
    actionId: z.string().min(8).max(160),
    ok: z.boolean(),
    state: z.enum(["confirmed", "failed", "stale"]),
    detail: z.string().max(2048).optional(),
    evidence: z
      .object({ repliedEvent: z.boolean(), pendingAbsent: z.boolean(), executionObserved: z.boolean() })
      .optional(),
  }),
  z.object({ type: z.literal("heartbeat"), at: z.number().int().nonnegative() }),
])
export type NodeToHub = z.infer<typeof NodeToHubSchema>

export const HubToNodeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    heartbeatMs: z.number().int(),
    telegramReachable: z.boolean(),
  }),
  z.object({ type: z.literal("ack"), seq: z.number().int().positive() }),
  ActionDispatchSchema,
  z.object({ type: z.literal("action.ack"), actionId: z.string().min(8).max(160) }),
  z.object({ type: z.literal("heartbeat.ack"), at: z.number().int().nonnegative() }),
])
export type HubToNode = z.infer<typeof HubToNodeSchema>

export function parseJson<Schema extends z.ZodType>(schema: Schema, value: string): z.infer<Schema> {
  return schema.parse(JSON.parse(value))
}

export function requestIdentity(event: {
  instanceId: string
  sessionId?: string | undefined
  location: Location
  requestId: string
}) {
  return [
    event.location.workspace ?? "",
    event.location.directory,
    event.instanceId,
    event.sessionId ?? "",
    event.requestId,
  ].join("\u001f")
}
