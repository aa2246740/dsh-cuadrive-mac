import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_ID = 'dsh-cuadrive-mac'
const LOG = `[my-plugins/${PLUGIN_ID}]`
const LEGACY_HOME_NAME = 'dsh-cua-drive'

export function isMacOS(): boolean {
  return process.platform === 'darwin'
}

export function dshHomeDir(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Private plugin state: vendor binary, socket, pid. Not the shared cua-driver cache. */
export function pluginHome(): string {
  const home = join(dshHomeDir(), PLUGIN_ID)
  migrateLegacyHome(home)
  return home
}

/** DSH-only cua-driver socket. Never `~/Library/Caches/cua-driver`. */
export function defaultSocketPath(): string {
  return join(pluginHome(), 'run', 'driver.sock')
}

/** Prefix every CLI invocation with `--socket` when this plugin owns a daemon. */
export function cliArgs(config: { ownDaemon: boolean, socketPath: string }, args: string[]): string[] {
  if (!config.ownDaemon) return [...args]
  const socket = config.socketPath.trim()
  if (socket.length === 0) {
    throw new Error(`${LOG} ownDaemon is on but socketPath is empty; refusing to talk to the shared cua-driver socket`)
  }
  return ['--socket', socket, ...args]
}

function migrateLegacyHome(home: string): void {
  const legacy = join(dshHomeDir(), LEGACY_HOME_NAME)
  if (existsSync(home) || !existsSync(legacy)) return
  mkdirSync(home, { recursive: true })
  for (const name of ['vendor', 'cache', 'bin', 'permissions.json', 'status.json', 'download.log']) {
    const from = join(legacy, name)
    const to = join(home, name)
    if (!existsSync(from) || existsSync(to)) continue
    cpSync(from, to, { recursive: true })
  }
}

export { LOG }
