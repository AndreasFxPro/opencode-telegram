import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { RoleSchema } from "./protocol.ts"

const defaultConfigDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode-telegram")
export const configPath = process.env.OPENCODE_TELEGRAM_CONFIG ?? join(defaultConfigDir, "config.json")
export const secretPath = join(dirname(configPath), "secrets.json")

export const ConfigSchema = z.object({
  mode: z.enum(["standalone", "hub", "node"]).default("standalone"),
  dataDir: z
    .string()
    .refine(
      (value) => isAbsolute(value) && !/[\r\n\0]/.test(value),
      "dataDir must be an absolute path without control characters",
    )
    .optional(),
  hub: z.object({ listen: z.string().default("127.0.0.1:47620"), publicUrl: z.string().url().optional() }).default({
    listen: "127.0.0.1:47620",
  }),
  node: z
    .object({
      name: z.string().min(1).max(256).default(hostname()),
      hubUrl: z.string().url().default("ws://127.0.0.1:47620/v1/node/ws"),
      allowInsecureHub: z.boolean().default(false),
      localListen: z.string().default("127.0.0.1:47621"),
      queueLimit: z.number().int().min(100).max(100000).default(10000),
    })
    .default({
      name: hostname(),
      hubUrl: "ws://127.0.0.1:47620/v1/node/ws",
      allowInsecureHub: false,
      localListen: "127.0.0.1:47621",
      queueLimit: 10000,
    }),
  telegram: z
    .object({
      apiBase: z.string().url().default("https://api.telegram.org"),
      authorizedChats: z
        .array(z.object({ id: z.number().int(), role: RoleSchema, threadId: z.number().int().optional() }))
        .default([]),
      authorizedUsers: z.array(z.object({ id: z.number().int(), role: RoleSchema })).default([]),
      pollTimeoutSeconds: z.number().int().min(1).max(50).default(25),
    })
    .default({ apiBase: "https://api.telegram.org", authorizedChats: [], authorizedUsers: [], pollTimeoutSeconds: 25 }),
  features: z.object({ remotePrompt: z.boolean().default(false) }).default({ remotePrompt: false }),
  dashboard: z
    .object({
      enabled: z.boolean().default(false),
      capture: z.enum(["metadata", "activity", "full"]).default("metadata"),
      retentionHours: z.number().int().min(1).max(720).default(24),
    })
    .default({ enabled: false, capture: "metadata", retentionHours: 24 }),
  notifications: z
    .object({
      permission: z.boolean().default(true),
      question: z.boolean().default(true),
      error: z.boolean().default(true),
      nodeJoin: z.boolean().default(true),
      done: z
        .object({ enabled: z.boolean().default(true), minimumDurationSeconds: z.number().min(0).default(20) })
        .default({
          enabled: true,
          minimumDurationSeconds: 20,
        }),
      includeBranch: z.boolean().default(true),
      includeTmux: z.boolean().default(true),
      includeModel: z.boolean().default(true),
      includeAgent: z.boolean().default(true),
      includeFinalPreview: z.boolean().default(false),
      previewMaxChars: z.number().int().min(20).max(1024).default(180),
    })
    .default({
      permission: true,
      question: true,
      error: true,
      nodeJoin: true,
      done: { enabled: true, minimumDurationSeconds: 20 },
      includeBranch: true,
      includeTmux: true,
      includeModel: true,
      includeAgent: true,
      includeFinalPreview: false,
      previewMaxChars: 180,
    }),
})
export type Config = z.infer<typeof ConfigSchema>

export const SecretsSchema = z.object({
  telegramBotToken: z.string().min(20).optional(),
  localPluginSecret: z.string().min(32),
  nodeId: z.string().min(8),
  nodeCredential: z.string().min(32).optional(),
  dashboardToken: z.string().min(32).optional(),
})
export type Secrets = z.infer<typeof SecretsSchema>

export function dataDir(config: Config) {
  return config.dataDir ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode-telegram")
}

export function loadConfig(): Config {
  if (!existsSync(configPath)) throw new Error(`Configuration not found: ${configPath}. Run 'opencode-telegram setup'.`)
  return ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
}

export function loadSecrets(): Secrets {
  if (!existsSync(secretPath)) throw new Error(`Secrets not found: ${secretPath}. Run 'opencode-telegram setup'.`)
  return SecretsSchema.parse(JSON.parse(readFileSync(secretPath, "utf8")))
}

export function saveConfig(config: Config, secrets: Secrets) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  writeFileSync(configPath, `${JSON.stringify(ConfigSchema.parse(config), null, 2)}\n`, { mode: 0o600 })
  writeFileSync(secretPath, `${JSON.stringify(SecretsSchema.parse(secrets), null, 2)}\n`, { mode: 0o600 })
  chmodSync(dirname(configPath), 0o700)
  chmodSync(configPath, 0o600)
  chmodSync(secretPath, 0o600)
}

export function splitListen(value: string): { hostname: string; port: number } {
  const index = value.lastIndexOf(":")
  if (index <= 0) throw new Error(`Invalid listen address '${value}', expected host:port`)
  const port = Number(value.slice(index + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port in '${value}'`)
  return { hostname: value.slice(0, index), port }
}
