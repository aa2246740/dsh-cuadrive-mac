import { existsSync } from 'node:fs'
import { LOG } from './argv.ts'
import { findVendorBinary, loadRuntimeLock } from './runtime.ts'

/**
 * Resolve the plugin-private cua-driver binary.
 * An absolute `configured` path is an explicit override (debug only).
 * The default never searches `/Applications` or `~/.local/bin`.
 */
export function resolveBinary(configured: string): string {
  if (configured.includes('/') || configured.includes('\\')) {
    if (!existsSync(configured)) {
      throw new Error(`${LOG} configured binary not found: ${configured}`)
    }
    return configured
  }
  const vendor = findVendorBinary()
  if (vendor) return vendor
  const lock = loadRuntimeLock()
  throw new Error(
    `${LOG} runtime is not installed. Call cua_status. The plugin downloads cua-driver ${lock.driver} (locked to plugin ${lock.plugin}) into $DSH_HOME/dsh-cuadrive-mac/vendor.`,
  )
}
