import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LOG, isMacOS } from './argv.ts'
import { Config, resolveConfig, type Config as PluginConfig, type ResolvedConfig } from './config.ts'
import { ensureOwnedDaemon, restartOwnedDaemon, startOwnedDaemon } from './daemon.ts'
import { warmHostCapture } from './driver.ts'
import { ensureHostPermissions, readHostPermissions } from './permissions.ts'
import {
  abortRuntimeInstall,
  ensureRuntime,
  findVendorBinary,
  loadRuntimeLock,
  readRuntimeStatus,
} from './runtime.ts'
import { startHostedSession } from './session-host.ts'
import { registerCuaSkill } from './skill.ts'
import { registerDriverTools, registerHostTools } from './tools.ts'

export const name = 'dsh-cuadrive-mac'
export const inject = ['tools', 'skills']

export { Config }

/**
 * DSH-owned Cua Driver: private daemon, first-class `cua_*` tools, DSH skill.
 * `defineTool` stays in this entry so `dshx check` sees a tool plugin.
 * apply() never spawnSync-downloads — host tools (including cua_status) register immediately.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  console.log('[my-plugins/dsh-cuadrive-mac] loaded')
  void defineTool
  const resolved = resolveConfig(config)
  registerHostTools(ctx, resolved)
  if (!isMacOS()) {
    ctx.logger.warn(`${LOG} macOS only — computer-use is not started on ${process.platform}.`)
    try {
      registerCuaSkill(ctx, resolved)
    } catch (error: unknown) {
      ctx.logger.warn(
        `${LOG} DSH skill not registered: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return
  }
  try {
    registerCuaSkill(ctx, resolved)
  } catch (error: unknown) {
    ctx.logger.warn(
      `${LOG} DSH skill not registered: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  startOwnedDaemon(ctx, resolved)

  const existing = findVendorBinary()
  if (existing) resolved.binary = existing

  ctx.effect(() => {
    let cancelled = false
    if (!existing) {
      const status = readRuntimeStatus()
      const lock = loadRuntimeLock()
      ctx.logger.warn(
        `${LOG} cua-driver ${lock.driver} (plugin ${lock.plugin}) is not in vendor yet — ${status.percent}%. Call cua_status or open ${status.statusPath}`,
      )
    }
    void (existing ? Promise.resolve(existing) : ensureRuntime(resolved)).then(async (binary) => {
      if (cancelled) return
      resolved.binary = binary
      const before = readHostPermissions()
      const perms = await ensureHostPermissions(resolved)
      if (cancelled) return
      if (!perms.accessibility || !perms.screenRecording) {
        ctx.logger.warn(`${LOG} ${perms.hint}`)
      }
      const refreshDaemon = !before.prompted || !before.accessibility || !before.screenRecording
      await (refreshDaemon ? restartOwnedDaemon : ensureOwnedDaemon)(resolved)
      if (cancelled) return
      onRuntimeReady(ctx, resolved)
      void warmHostCapture(resolved).catch((error: unknown) => {
        ctx.logger.warn(
          `${LOG} first-launch capture probe: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      const failed = readRuntimeStatus()
      ctx.logger.warn(
        `${LOG} ${error instanceof Error ? error.message : String(error)}. ${failed.hint} ${readHostPermissions().hint}`,
      )
    })
    return () => {
      cancelled = true
      abortRuntimeInstall()
    }
  }, 'dsh-cuadrive-mac.runtime')
}

function onRuntimeReady(ctx: Context, resolved: ResolvedConfig): void {
  if (resolved.registerDriverTools) {
    try {
      const names = registerDriverTools(ctx, resolved)
      console.log(`${LOG} registered ${names.length} driver tools`)
    } catch (error: unknown) {
      ctx.logger.warn(
        `${LOG} driver tools unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  startHostedSession(ctx, resolved)
}
