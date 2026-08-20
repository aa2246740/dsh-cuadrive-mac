import type { ResolvedConfig } from './config.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { readDaemonStatus, readDoctor, readPermissions, resolveBinary } from './driver.ts'
import { permissionsHint, readHostPermissions } from './permissions.ts'
import { readRuntimeStatus, resolvedProxy, runtimeAvailable } from './runtime.ts'
import { resolveSkillDir } from './skill.ts'

/** Same payload `cua_status` returns. Must be DSH lossless JSON (no `undefined`). */
export async function buildCuaStatus(config: ResolvedConfig, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
  const status = readRuntimeStatus()
  const runtime = {
    ...status,
    proxy: resolvedProxy(config) || status.proxy || '',
  }
  let binary = config.binary
  try {
    binary = resolveBinary(config.binary)
  } catch {
    binary = ''
  }
  const hostPermissions = readHostPermissions()
  const ready = runtimeAvailable(config)
  const [daemon, permissions, doctor] = ready
    ? await Promise.all([
      readDaemonStatus(config, signal),
      readPermissions(config, signal),
      readDoctor(config, signal),
    ])
    : [
      { running: false, raw: runtime.message },
      { error: runtime.message },
      { error: runtime.message },
    ]
  const value = {
    plugin: 'dsh-cuadrive-mac',
    pluginVersion: runtime.plugin,
    lockedDriver: runtime.driver,
    lockedSkill: runtime.skill,
    runtime,
    binary,
    socketPath: config.socketPath,
    ownDaemon: config.ownDaemon,
    daemon,
    hostPermissions,
    permissions,
    doctor,
    skillDir: resolveSkillDir(config),
    hostedSession: config.sessionId,
    hint: statusHint(runtime.phase, runtime.hint, daemon.running === true, hostPermissions),
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function statusHint(
  phase: string,
  runtimeHint: string,
  daemonRunning: boolean,
  hostPermissions: { accessibility: boolean, screenRecording: boolean, hint: string },
): string {
  if (phase === 'downloading' || phase === 'verifying' || phase === 'extracting') {
    return runtimeHint
  }
  if (phase === 'error' || phase === 'missing') {
    return runtimeHint
  }
  const permHint = permissionsHint(hostPermissions)
  if (!hostPermissions.accessibility || !hostPermissions.screenRecording) {
    return permHint
  }
  if (daemonRunning) {
    return 'DSH-owned daemon is up on the private socket. Snapshot with cua_get_window_state before element-indexed actions.'
  }
  return 'Private runtime is installed. The DSH-owned daemon starts on the private socket; it does not install or stop the machine CuaDriver.app.'
}
