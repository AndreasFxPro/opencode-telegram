import { z } from "zod"

export const MissionPrioritySchema = z.enum(["urgent", "high", "normal", "low"])
export type MissionPriority = z.infer<typeof MissionPrioritySchema>

export const MissionWorkStateSchema = z.enum([
  "backlog",
  "ready",
  "planning",
  "running",
  "verifying",
  "blocked",
  "review",
  "completed",
  "cancelled",
])
export type MissionWorkState = z.infer<typeof MissionWorkStateSchema>

export const MissionProjectCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(4000).default(""),
  repository: z.string().trim().max(2048).optional(),
  priority: MissionPrioritySchema.default("normal"),
})
export type MissionProjectCreate = z.input<typeof MissionProjectCreateSchema>

export const MissionWorkCreateSchema = z.object({
  projectId: z.string().min(8).max(160),
  title: z.string().trim().min(1).max(512),
  description: z.string().trim().max(12_000).default(""),
  acceptance: z.string().trim().max(8000).default(""),
  priority: MissionPrioritySchema.default("normal"),
})
export type MissionWorkCreate = z.input<typeof MissionWorkCreateSchema>

const transitions: Record<MissionWorkState, ReadonlySet<MissionWorkState>> = {
  backlog: new Set(["ready", "cancelled"]),
  ready: new Set(["planning", "running", "blocked", "cancelled"]),
  planning: new Set(["ready", "running", "blocked", "cancelled"]),
  running: new Set(["verifying", "blocked", "review", "completed", "cancelled"]),
  verifying: new Set(["running", "blocked", "review", "completed", "cancelled"]),
  blocked: new Set(["ready", "planning", "running", "cancelled"]),
  review: new Set(["running", "blocked", "completed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
}

export function missionTransitionAllowed(from: MissionWorkState, to: MissionWorkState) {
  return from === to || transitions[from].has(to)
}

export const missionPriorityRank: Record<MissionPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export const missionStateRank: Record<MissionWorkState, number> = {
  blocked: 0,
  review: 1,
  verifying: 2,
  running: 3,
  planning: 4,
  ready: 5,
  backlog: 6,
  completed: 7,
  cancelled: 8,
}

export function missionWorkActive(state: MissionWorkState) {
  return state !== "completed" && state !== "cancelled"
}

export type MissionProjectView = {
  id: string
  key: string
  name: string
  description: string
  repository?: string
  priority: MissionPriority
  activeWork: number
  blockedWork: number
  reviewWork: number
  activeSessions: number
  updatedAt: number
  version: number
}

export type MissionWorkItemView = {
  id: string
  projectId: string
  projectKey: string
  projectName: string
  title: string
  description: string
  acceptance: string
  state: MissionWorkState
  priority: MissionPriority
  sessionKey?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
  version: number
}

export type MissionInboxItem = {
  key: string
  kind: "permission" | "question" | "blocked_work"
  state: "pending" | "dispatching" | "failed" | "blocked"
  title: string
  summary: string
  project: string
  nodeName?: string
  sessionKey?: string
  workItemId?: string
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

export type MissionControlSnapshot = {
  totals: {
    projects: number
    activeWork: number
    blocked: number
    review: number
    inbox: number
  }
  projects: MissionProjectView[]
  workItems: MissionWorkItemView[]
  inbox: MissionInboxItem[]
}
