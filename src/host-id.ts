import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export type HostKind = 'app' | 'cli'

/** Process whose TCC macOS will actually check: DSH.app, or Terminal/IDE if `dsh web` is CLI. */
export interface HostIdentity {
  bundleId: string
  label: string
  kind: HostKind
  executable: string
}

/** Best-effort CFBundleIdentifier of the app that spawned this plugin. */
export function detectHostBundleId(): string {
  return detectHost().bundleId
}

export function detectHost(): HostIdentity {
  const envId = (process.env.CUA_DRIVER_HOST_BUNDLE_ID || process.env.DSH_APP_BUNDLE_ID || '').trim()
  const envLabel = (process.env.DSH_APP_NAME || '').trim()
  if (envId.length > 0) {
    return {
      bundleId: envId,
      label: envLabel || labelFromBundleId(envId),
      kind: 'app',
      executable: process.execPath,
    }
  }
  if (process.platform !== 'darwin') {
    return {
      bundleId: '',
      label: 'this dsh process',
      kind: 'cli',
      executable: process.execPath,
    }
  }
  const fromExe = identityFromExecutable(process.execPath)
  if (fromExe) return fromExe
  let pid = process.ppid
  for (let i = 0; i < 10 && pid > 1; i++) {
    const info = processInfo(pid)
    if (!info) break
    const id = identityFromExecutable(info.comm)
    if (id) return id
    pid = info.ppid
  }
  return {
    bundleId: '',
    label: 'the terminal or IDE that launched dsh',
    kind: 'cli',
    executable: process.execPath,
  }
}

export function parsePlistBundleId(xml: string): string {
  return parsePlistString(xml, 'CFBundleIdentifier')
}

export function parsePlistString(xml: string, key: string): string {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>\\s*([^<]+)\\s*</string>`, 'i').exec(xml)
  return match?.[1]?.trim() ?? ''
}

export function bundleIdFromExecutable(executable: string): string {
  return identityFromExecutable(executable)?.bundleId ?? ''
}

function identityFromExecutable(executable: string): HostIdentity | undefined {
  const normalized = executable.replace(/\\/g, '/')
  const marker = '.app/Contents/MacOS/'
  const at = normalized.toLowerCase().lastIndexOf(marker)
  if (at < 0) return undefined
  const appRoot = normalized.slice(0, at + 4)
  const plist = join(appRoot, 'Contents', 'Info.plist')
  if (!existsSync(plist)) {
    const base = appRoot.split('/').filter(Boolean).at(-1)?.replace(/\.app$/i, '') ?? 'host app'
    return { bundleId: '', label: base, kind: 'app', executable: normalized }
  }
  const bundleId = readPlistField(plist, 'CFBundleIdentifier') || parsePlistBundleId(safeRead(plist))
  const name = readPlistField(plist, 'CFBundleDisplayName')
    || readPlistField(plist, 'CFBundleName')
    || parsePlistString(safeRead(plist), 'CFBundleDisplayName')
    || parsePlistString(safeRead(plist), 'CFBundleName')
    || labelFromBundleId(bundleId)
  return {
    bundleId,
    label: name || 'host app',
    kind: 'app',
    executable: normalized,
  }
}

function readPlistField(plist: string, key: string): string {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.status !== 0) return ''
  const value = (result.stdout || '').trim()
  if (!value || value === '(null)' || /error|could not/i.test(value)) return ''
  return value
}

function labelFromBundleId(bundleId: string): string {
  if (bundleId === 'local.dsh.desktop') return 'DSH'
  const last = bundleId.split('.').filter(Boolean).at(-1)
  return last || bundleId || 'host app'
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function processInfo(pid: number): { ppid: number, comm: string } | undefined {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,comm='], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.status !== 0) return undefined
  const line = (result.stdout || '').trim()
  const split = line.match(/^(\d+)\s+(.+)$/)
  if (!split) return undefined
  return { ppid: Number(split[1]), comm: split[2].trim() }
}
