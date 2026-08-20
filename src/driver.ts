import { execFile as execFileCallback, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cliArgs } from './argv.ts'
import { resolveBinary } from './binary.ts'
import type { ResolvedConfig } from './config.ts'
import { ensureOwnedDaemon } from './daemon.ts'
import { extractJson, parseDescribe, parseListTools, type DescribedTool, type ListedTool } from './parse.ts'

const execFile = promisify(execFileCallback)
const MAX_BUFFER = 32 * 1024 * 1024

export interface DriverRun {
  stdout: string
  stderr: string
}

export interface DaemonStatus {
  running: boolean
  raw: string
  payload?: unknown
}

export { resolveBinary }

/** Run cua-driver and throw the combined stderr/stdout on a non-zero exit. */
export async function runDriver(
  config: ResolvedConfig,
  args: string[],
  options: { signal?: AbortSignal, timeoutMs?: number } = {},
): Promise<DriverRun> {
  const binary = resolveBinary(config.binary)
  const argv = cliArgs(config, args)
  try {
    const result = await execFile(binary, argv, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? config.timeoutMs,
      signal: options.signal,
      env: process.env,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error: unknown) {
    throw driverError(binary, argv, error)
  }
}

/** Synchronous CLI used during `apply` (list/describe). */
export function runDriverSync(config: ResolvedConfig, args: string[], timeoutMs = 15_000): DriverRun {
  const binary = resolveBinary(config.binary)
  const argv = cliArgs(config, args)
  const result = spawnSync(binary, argv, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    env: process.env,
  })
  if (result.error) throw driverError(binary, argv, result.error)
  if (result.status !== 0) {
    throw new Error(formatFailure(binary, argv, result.stdout, result.stderr, result.status))
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/** `cua-driver list-tools`. Does not need the daemon. */
export function listDriverTools(config: ResolvedConfig): ListedTool[] {
  return parseListTools(runDriverSync({ ...config, ownDaemon: false, socketPath: '' }, ['list-tools']).stdout)
}

/** `cua-driver describe <name>`. Does not need the daemon. */
export function describeDriverTool(config: ResolvedConfig, tool: string): DescribedTool {
  return parseDescribe(runDriverSync({ ...config, ownDaemon: false, socketPath: '' }, ['describe', tool]).stdout)
}

/** `cua-driver call <tool> <json>`. Requires the DSH-owned daemon. */
export async function callDriverTool(
  config: ResolvedConfig,
  tool: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal, screenshotOutFile?: string } = {},
): Promise<unknown> {
  await ensureDaemon(config, options.signal)
  const argv = ['call', tool, JSON.stringify(args)]
  if (options.screenshotOutFile) argv.push('--screenshot-out-file', options.screenshotOutFile)
  const run = await runDriver(config, argv, { signal: options.signal })
  return normalizeDriverOutput(run.stdout.trim() || run.stderr.trim())
}

/** Timeout replies are plaintext + exit 0; success is JSON. */
export function normalizeDriverOutput(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: true }
  try {
    return extractJson(trimmed)
  } catch {
    return { text: trimmed }
  }
}

/** Best-effort daemon probe against this plugin's socket. */
export async function readDaemonStatus(config: ResolvedConfig, signal?: AbortSignal): Promise<DaemonStatus> {
  try {
    const run = await runDriver(config, ['status', '--json'], { signal, timeoutMs: 8_000 })
    const payload = safeJson(run.stdout)
    return { running: isRunningPayload(payload) || /daemon is running/i.test(run.stdout), raw: run.stdout, payload }
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error)
    return { running: false, raw }
  }
}

/** Live TCC of the DSH host via the private daemon (`check_permissions`). Not `permissions status` (that talks to CuaDriver.app). */
export async function readPermissions(config: ResolvedConfig, signal?: AbortSignal): Promise<unknown> {
  try {
    const run = await runDriver(config, ['call', 'check_permissions', JSON.stringify({ prompt: false })], {
      signal,
      timeoutMs: 8_000,
    })
    return normalizeDriverOutput(run.stdout.trim() || run.stderr.trim())
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** `cua-driver doctor --json` when the flag works; otherwise doctor text. */
export async function readDoctor(config: ResolvedConfig, signal?: AbortSignal): Promise<unknown> {
  try {
    const run = await runDriver({ ...config, ownDaemon: false, socketPath: '' }, ['doctor', '--json'], { signal, timeoutMs: 12_000 })
    return safeJson(run.stdout) ?? run.stdout
  } catch {
    try {
      const run = await runDriver({ ...config, ownDaemon: false, socketPath: '' }, ['doctor'], { signal, timeoutMs: 12_000 })
      return run.stdout
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** First-open ScreenCaptureKit probe so macOS lists DSH in Screen Recording before a real GUI task. */
export async function warmHostCapture(config: ResolvedConfig, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await callDriverTool(config, 'get_desktop_state', {
      ...config.sessionId ? { session: config.sessionId } : {},
    }, { signal })
  } catch {
    // Probe only: a deny is reported via cua_status / check_permissions.
  }
}

/** Start the DSH-owned daemon (never the shared default socket). */
export async function ensureDaemon(config: ResolvedConfig, signal?: AbortSignal): Promise<void> {
  if (config.ownDaemon) {
    await ensureOwnedDaemon(config, signal)
    return
  }
  throw new Error('dsh-cuadrive-mac requires ownDaemon; it does not share the default cua-driver socket')
}

function isRunningPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  if (record.running === true) return true
  if (typeof record.status === 'string' && /running/i.test(record.status)) return true
  return false
}

function safeJson(text: string): unknown {
  try {
    return extractJson(text)
  } catch {
    return undefined
  }
}

function driverError(binary: string, args: string[], error: unknown): Error {
  if (isExecError(error)) {
    return new Error(formatFailure(binary, args, error.stdout, error.stderr, error.status ?? error.code))
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error(
      `cua-driver executable not found (${binary}). Call cua_status — dsh-cuadrive-mac vendors its own lock-pinned binary and does not use /Applications/CuaDriver.app.`,
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

function formatFailure(
  binary: string,
  args: string[],
  stdout: string | undefined,
  stderr: string | undefined,
  status: unknown,
): string {
  const detail = (stderr || stdout || '').trim() || `exit ${String(status)}`
  return `cua-driver ${args.join(' ')} failed (bin=${binary}): ${detail}`
}

function isExecError(error: unknown): error is { stdout?: string, stderr?: string, status?: number, code?: string } {
  return typeof error === 'object' && error !== null && ('stdout' in error || 'stderr' in error)
}
