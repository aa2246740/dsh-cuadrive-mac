import z from '@deepseek-ai/schemastery'
import { defaultSocketPath } from './argv.ts'

/** Plugin configuration resolved before `apply`. */
export interface Config {
  /** Absolute override for the private cua-driver binary. Empty uses the plugin vendor dir. */
  binary?: string
  /** Start a DSH-owned CuaDriver serve when our socket is down. Default true. */
  autoStart?: boolean
  /** Per-call deadline in milliseconds. Default 90000. */
  timeoutMs?: number
  /** Register every driver tool as `cua_<name>`. Default true. */
  registerDriverTools?: boolean
  /** Skill pack directory. Empty uses the plugin-vendored official pack only. */
  skillDir?: string
  /** Plugin-hosted cua session id on the DSH-owned daemon. Default `dsh`. Empty disables hosting. */
  sessionId?: string
  /** How often to refresh the hosted session idle TTL. Default 60000. */
  heartbeatMs?: number
  /** Isolate from other agents' cua-driver daemons. Default true. */
  ownDaemon?: boolean
  /** Unix socket for the DSH-owned daemon. Empty uses `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock`. */
  socketPath?: string
  /** HTTP(S) proxy for the lock-pinned GitHub download (梯子). Empty uses HTTPS_PROXY / ALL_PROXY / DSH_CUA_DRIVE_PROXY. */
  proxy?: string
  /** On first DSH launch, prompt macOS for Accessibility + Screen Recording as DSH (not CuaDriver.app). Default true. */
  promptPermissions?: boolean
}

/** Schemastery schema so Cordis fills defaults before `apply`. */
export const Config: z<Config> = z.object({
  binary: z.string().default(''),
  autoStart: z.boolean().default(true),
  timeoutMs: z.number().min(1000).default(90_000),
  registerDriverTools: z.boolean().default(true),
  skillDir: z.string().default(''),
  sessionId: z.string().default('dsh'),
  heartbeatMs: z.number().min(5_000).default(60_000),
  ownDaemon: z.boolean().default(true),
  socketPath: z.string().default(''),
  proxy: z.string().default(''),
  promptPermissions: z.boolean().default(true),
})

/** Config after Schemastery defaults. */
export interface ResolvedConfig {
  binary: string
  autoStart: boolean
  timeoutMs: number
  registerDriverTools: boolean
  skillDir: string
  sessionId: string
  heartbeatMs: number
  ownDaemon: boolean
  socketPath: string
  proxy: string
  promptPermissions: boolean
}

/** Fill defaults for programmatic callers that skip Schemastery. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const ownDaemon = config.ownDaemon ?? true
  return {
    binary: config.binary?.trim() || '',
    autoStart: config.autoStart ?? true,
    timeoutMs: config.timeoutMs ?? 90_000,
    registerDriverTools: config.registerDriverTools ?? true,
    skillDir: config.skillDir?.trim() ?? '',
    sessionId: config.sessionId?.trim() || 'dsh',
    heartbeatMs: config.heartbeatMs ?? 60_000,
    ownDaemon,
    socketPath: config.socketPath?.trim() || (ownDaemon ? defaultSocketPath() : ''),
    proxy: config.proxy?.trim() || '',
    promptPermissions: config.promptPermissions ?? true,
  }
}
