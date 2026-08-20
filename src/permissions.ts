import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOG, pluginHome } from './argv.ts'
import type { ResolvedConfig } from './config.ts'
import { detectHost } from './host-id.ts'

export const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
export const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export interface HostPermissions {
  platform: string
  prompted: boolean
  promptedAt: string
  accessibility: boolean
  screenRecording: boolean
  hostBundleId: string
  hostLabel: string
  hostKind: 'app' | 'cli'
  helper: string
  hint: string
  error: string
  settingsOpened: boolean
}

export const TCC_PROMPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'host-tcc-prompt.c')

export function permissionsStatePath(): string {
  return join(pluginHome(), 'permissions.json')
}

export function tccPromptHelperPath(): string {
  return join(pluginHome(), 'bin', `host-tcc-prompt-${process.arch}`)
}

export function tccPromptClangArgs(source = TCC_PROMPT_SOURCE, dest = tccPromptHelperPath()): string[] {
  return ['-Os', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', '-framework', 'CoreFoundation', '-o', dest, source]
}

export function parseTccPromptOutput(text: string): { accessibility: boolean, screenRecording: boolean } | undefined {
  try {
    const parsed = JSON.parse(text.trim()) as { accessibility?: unknown, screenRecording?: unknown }
    if (typeof parsed.accessibility !== 'boolean' || typeof parsed.screenRecording !== 'boolean') return undefined
    return { accessibility: parsed.accessibility, screenRecording: parsed.screenRecording }
  } catch {
    return undefined
  }
}

export function readHostPermissions(): HostPermissions {
  const fallback = emptyPermissions()
  if (!existsSync(permissionsStatePath())) return fallback
  try {
    const parsed = JSON.parse(readFileSync(permissionsStatePath(), 'utf8')) as Partial<HostPermissions>
    return JSON.parse(JSON.stringify({
      ...fallback,
      ...parsed,
      error: parsed.error ?? '',
      hint: parsed.hint ?? fallback.hint,
      helper: parsed.helper ?? '',
      hostBundleId: parsed.hostBundleId ?? detectHost().bundleId,
      hostLabel: parsed.hostLabel ?? detectHost().label,
      hostKind: parsed.hostKind === 'cli' || parsed.hostKind === 'app' ? parsed.hostKind : detectHost().kind,
    })) as HostPermissions
  } catch {
    return fallback
  }
}

export function writeHostPermissions(patch: Partial<HostPermissions>): HostPermissions {
  const current = readHostPermissions()
  const next = JSON.parse(JSON.stringify({
    ...current,
    ...patch,
    error: patch.error ?? current.error ?? '',
  })) as HostPermissions
  mkdirSync(pluginHome(), { recursive: true })
  writeFileSync(permissionsStatePath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function emptyPermissions(): HostPermissions {
  const macos = process.platform === 'darwin'
  const host = detectHost()
  return {
    platform: process.platform,
    prompted: false,
    promptedAt: '',
    accessibility: !macos,
    screenRecording: !macos,
    hostBundleId: host.bundleId,
    hostLabel: host.label,
    hostKind: host.kind,
    helper: '',
    hint: macos
      ? grantHint(host.label, host.kind, true, true)
      : 'Host TCC prompts are macOS-only. CLI dsh (no app pack) works on this platform.',
    error: '',
    settingsOpened: false,
  }
}

/**
 * Ask macOS for Accessibility + Screen Recording as the DSH host.
 * Never runs `cua-driver permissions grant` (that launches CuaDriver.app).
 */
export async function ensureHostPermissions(config: Pick<ResolvedConfig, 'promptPermissions'>): Promise<HostPermissions> {
  if (process.platform !== 'darwin' || config.promptPermissions === false) {
    return writeHostPermissions({
      prompted: false,
      accessibility: true,
      screenRecording: true,
      hint: process.platform === 'darwin' ? 'Permission prompting is disabled in config.' : 'Host TCC prompts are macOS-only.',
    })
  }
  const host = detectHost()
  const helper = ensureTccPromptHelper()
  let grants = { accessibility: false, screenRecording: false }
  let helperPath = helper ?? ''
  let error = ''
  if (helper) {
    try {
      grants = await runTccPromptHelper(helper)
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err)
    }
  } else {
    error = 'could not build the DSH TCC helper (clang missing?)'
  }
  const missing: string[] = []
  if (!grants.accessibility) missing.push('Accessibility')
  if (!grants.screenRecording) missing.push('Screen Recording')
  const current = readHostPermissions()
  let settingsOpened = current.settingsOpened
  if (missing.length > 0 && !settingsOpened) {
    openPrivacySettings(!grants.accessibility, !grants.screenRecording)
    settingsOpened = true
  }
  const hint = grantHint(host.label, host.kind, grants.accessibility, grants.screenRecording)
  return writeHostPermissions({
    prompted: true,
    promptedAt: new Date().toISOString(),
    accessibility: grants.accessibility,
    screenRecording: grants.screenRecording,
    hostBundleId: host.bundleId,
    hostLabel: host.label,
    hostKind: host.kind,
    helper: helperPath,
    hint,
    error,
    settingsOpened,
  })
}

export function grantHint(label: string, kind: 'app' | 'cli', accessibility: boolean, screenRecording: boolean): string {
  const who = label.trim() || (kind === 'cli' ? 'the terminal or IDE that launched dsh' : 'the DSH host')
  const cli = kind === 'cli'
    ? ' This dsh process is CLI (no DSH.app pack). macOS lists the terminal or IDE that launched `dsh`, not a DSH icon.'
    : ''
  if (accessibility && screenRecording) {
    return `${who} has Accessibility and Screen Recording.${cli} Grant belongs to that host, not CuaDriver.app.`
  }
  const missing = [
    ...accessibility ? [] : ['Accessibility'],
    ...screenRecording ? [] : ['Screen Recording'],
  ]
  return `Enable ${missing.join(' and ')} for ${who} in System Settings → Privacy & Security, then restart dsh.${cli} Do not grant CuaDriver.app for this plugin.`
}

export function permissionsHint(state: HostPermissions): string {
  if (process.platform !== 'darwin') return ''
  if (state.accessibility && state.screenRecording) return state.hint
  return state.hint
}

function ensureTccPromptHelper(): string | undefined {
  const dest = tccPromptHelperPath()
  if (existsSync(dest) && existsSync(TCC_PROMPT_SOURCE)) {
    try {
      if (statSync(dest).mtimeMs >= statSync(TCC_PROMPT_SOURCE).mtimeMs) return dest
    } catch {
      // rebuild
    }
  }
  if (!existsSync(TCC_PROMPT_SOURCE)) return undefined
  mkdirSync(dirname(dest), { recursive: true })
  const clang = spawnSync('clang', tccPromptClangArgs(TCC_PROMPT_SOURCE, dest), { encoding: 'utf8', timeout: 30_000 })
  if (clang.status !== 0 || !existsSync(dest)) {
    return undefined
  }
  return dest
}

function runTccPromptHelper(helper: string): Promise<{ accessibility: boolean, screenRecording: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code) => {
      const parsed = parseTccPromptOutput(stdout)
      if (parsed) {
        resolve(parsed)
        return
      }
      reject(new Error(`${LOG} TCC helper failed (exit ${String(code)}): ${(stderr || stdout).trim() || 'no output'}`))
    })
  })
}

function openPrivacySettings(accessibility: boolean, screenRecording: boolean): void {
  if (accessibility) spawn('open', [ACCESSIBILITY_SETTINGS_URL], { stdio: 'ignore', detached: true }).unref()
  if (screenRecording) spawn('open', [SCREEN_RECORDING_SETTINGS_URL], { stdio: 'ignore', detached: true }).unref()
}
