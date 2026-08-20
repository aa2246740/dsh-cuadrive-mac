import type { Context } from '@deepseek-ai/cordis'
import { LOG } from './argv.ts'
import type { ResolvedConfig } from './config.ts'
import { callDriverTool } from './driver.ts'

/** Keep the plugin-owned cua session alive for the DSH process, like Codex's MCP connection. */
export function startHostedSession(ctx: Context, config: ResolvedConfig): void {
  if (config.sessionId.length === 0) return
  const tick = (): void => {
    void callDriverTool(config, 'start_session', { session: config.sessionId }).catch((error: unknown) => {
      ctx.logger.warn(
        `${LOG} hosted session refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }
  tick()
  ctx.effect(() => {
    const timer = setInterval(tick, config.heartbeatMs)
    return () => clearInterval(timer)
  }, 'dsh-cuadrive-mac.session-host')
}
