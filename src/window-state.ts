/** Defaults and timeout detection for `get_window_state`. */

const AX_TIMEOUT = /timed out after\s+\d+\s*s/i

/** Proven against Notes “iCloud全部” (765 notes): 200/8 ≈ 4s + screenshot; unbounded always 20s timeout. */
export const DEFAULT_MAX_ELEMENTS = 200
export const DEFAULT_MAX_DEPTH = 8
export const RETRY_MAX_ELEMENTS = 80
export const RETRY_MAX_DEPTH = 6

/** True when cua-driver gave up walking a huge AX tree. */
export function looksLikeAxTimeout(data: unknown): boolean {
  if (typeof data === 'string') return AX_TIMEOUT.test(data)
  if (!data || typeof data !== 'object') return false
  const record = data as Record<string, unknown>
  if (typeof record.text === 'string' && AX_TIMEOUT.test(record.text)) return true
  try {
    return AX_TIMEOUT.test(JSON.stringify(data))
  } catch {
    return false
  }
}

/**
 * Notes / iCloud / Electron apps blow the driver's 20s full-tree walk.
 * Fill bounds only when the caller omitted them.
 */
export function boundWindowStateArgs(
  args: Record<string, unknown>,
  tighter = false,
): Record<string, unknown> {
  const next = { ...args }
  if (next.max_elements === undefined) {
    next.max_elements = tighter ? RETRY_MAX_ELEMENTS : DEFAULT_MAX_ELEMENTS
  }
  if (next.max_depth === undefined) {
    next.max_depth = tighter ? RETRY_MAX_DEPTH : DEFAULT_MAX_DEPTH
  }
  return next
}

export function shouldRetryWindowState(
  args: Record<string, unknown>,
  data: unknown,
): boolean {
  return looksLikeAxTimeout(data) && (args.max_elements === undefined || args.max_depth === undefined)
}

const SLIM_KEYS = ['element_index', 'element_token', 'role', 'label', 'value', 'frame', 'actions'] as const

/** Cut duplicate markdown so a 765-note window does not flood the next model turn. */
export function compactWindowStateData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const record = { ...(data as Record<string, unknown>) }
  if (Array.isArray(record.elements)) {
    record.elements = record.elements.map(slimElement)
  }
  if (typeof record.tree_markdown === 'string' && record.tree_markdown.length > 6_000) {
    record.tree_markdown = `${record.tree_markdown.slice(0, 6_000)}\n…[truncated; prefer elements[]]`
  }
  return record
}

function slimElement(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SLIM_KEYS) {
    if (src[key] !== undefined) out[key] = src[key]
  }
  return Object.keys(out).length > 0 ? out : value
}
