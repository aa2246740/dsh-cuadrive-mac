/** Shrink list_apps payloads (session-6705 was 30KB of empty windows: []). */

export function compactListAppsData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const record = { ...(data as Record<string, unknown>) }
  if (!Array.isArray(record.apps)) return record
  record.apps = record.apps.map((app) => {
    if (!app || typeof app !== 'object' || Array.isArray(app)) return app
    const next = { ...(app as Record<string, unknown>) }
    if (Array.isArray(next.windows) && next.windows.length === 0) delete next.windows
    return next
  })
  return record
}
