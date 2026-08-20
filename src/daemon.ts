import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LOG, cliArgs } from './argv.ts'
import { resolveBinary } from './binary.ts'
import type { ResolvedConfig } from './config.ts'
import { detectHostBundleId } from './host-id.ts'

const DAEMON_WAIT_MS = 12_000
let ownedChild: ChildProcess | undefined

export interface ServeLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** Args/env for the DSH-owned daemon. Never `open -a CuaDriver`. */
export function serveLaunch(config: ResolvedConfig, binary: string): ServeLaunch {
  const hostBundleId = detectHostBundleId()
  return {
    command: binary,
    args: cliArgs(config, ['serve', '--embedded', '--no-permissions-gate']),
    env: {
      ...process.env,
      CUA_DRIVER_EMBEDDED: '1',
      ...hostBundleId ? { CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId } : {},
    },
  }
}

/** Start a DSH-private cua-driver serve and stop only that instance on unload. */
export function startOwnedDaemon(ctx: Context, config: ResolvedConfig): void {
  if (!config.ownDaemon) return
  ctx.effect(() => {
    return () => {
      stopOwnedDaemon(config)
    }
  }, 'dsh-cuadrive-mac.daemon')
}

/** Restart the DSH-owned serve so it re-reads host TCC after a first-launch grant. */
export async function restartOwnedDaemon(config: ResolvedConfig, signal?: AbortSignal): Promise<void> {
  stopOwnedDaemon(config)
  await ensureOwnedDaemon(config, signal)
}

/** Bring up `serve --embedded --socket <dsh socket>` without touching the default daemon. */
export async function ensureOwnedDaemon(config: ResolvedConfig, signal?: AbortSignal): Promise<void> {
  if (!config.ownDaemon) return
  if (ownedDaemonRunning(config)) return
  if (!config.autoStart) {
    throw new Error(
      `${LOG} DSH cua-driver daemon is not running on ${config.socketPath}.`,
    )
  }
  mkdirSync(dirname(config.socketPath), { recursive: true })
  unlinkStaleSocket(config.socketPath)
  startOwnedServe(config)
  const deadline = Date.now() + DAEMON_WAIT_MS
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    await sleep(400, signal)
    if (ownedDaemonRunning(config)) return
  }
  throw new Error(`${LOG} owned daemon did not come up on ${config.socketPath} within ${DAEMON_WAIT_MS}ms`)
}

/** Stop only the DSH socket. Never a bare `cua-driver stop`. */
export function stopOwnedDaemon(config: ResolvedConfig): void {
  if (!config.ownDaemon || config.socketPath.trim().length === 0) return
  const child = ownedChild
  ownedChild = undefined
  if (child?.pid) {
    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
  try {
    const binary = resolveBinary(config.binary)
    spawnSync(binary, cliArgs(config, ['stop']), {
      encoding: 'utf8',
      timeout: 8_000,
      env: process.env,
    })
  } catch {
    // binary may already be gone during tests
  }
}

export function ownedDaemonRunning(config: ResolvedConfig): boolean {
  if (!config.ownDaemon) return false
  let binary: string
  try {
    binary = resolveBinary(config.binary)
  } catch {
    return false
  }
  const result = spawnSync(binary, cliArgs(config, ['status', '--json']), {
    encoding: 'utf8',
    timeout: 5_000,
    env: process.env,
  })
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return result.status === 0 && /daemon is running/i.test(text)
}

function startOwnedServe(config: ResolvedConfig): void {
  const binary = resolveBinary(config.binary)
  const launch = serveLaunch(config, binary)
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: 'ignore',
    detached: false,
  })
  child.unref()
  ownedChild = child
}

function unlinkStaleSocket(socketPath: string): void {
  if (!existsSync(socketPath)) return
  try {
    unlinkSync(socketPath)
  } catch {
    // serve will fail loudly if the path is still bound
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}
