const ENDED = /session '([^']+)' has ended/i

/** Parse cua-driver's idle-TTL rejection from session-6705. */
export function endedSessionId(message: string): string | undefined {
  return ENDED.exec(message)?.[1]
}

/**
 * Named session to keep alive. Codex MCP keeps one implicit session on the
 * stdio connection; CLI `call` is one-shot, so DSH must own the id.
 */
export function sessionToRefresh(args: Record<string, unknown>): string | undefined {
  if (typeof args.session !== 'string') return undefined
  const session = args.session.trim()
  return session.length > 0 ? session : undefined
}

/** Prefer the model's session; otherwise the plugin-hosted id. */
export function attachPluginSession(
  args: Record<string, unknown>,
  pluginSession: string,
): Record<string, unknown> {
  if (sessionToRefresh(args) !== undefined) return args
  if (pluginSession.trim().length === 0) return args
  return { ...args, session: pluginSession }
}
