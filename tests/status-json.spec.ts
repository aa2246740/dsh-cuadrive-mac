import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { buildCuaStatus } from '../src/status.ts'

function assertLossless(value: unknown, path = '$'): void {
  if (value === undefined) assert.fail(`${path} is undefined (DSH rejects this as lossless JSON)`)
  if (typeof value === 'number' && !Number.isFinite(value)) assert.fail(`${path} is non-finite`)
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    assert.fail(`${path} is ${typeof value}`)
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) assertLossless(value[i], `${path}[${i}]`)
      return
    }
    for (const [key, child] of Object.entries(value)) assertLossless(child, `${path}.${key}`)
  }
}

test('cua_status payload is lossless JSON even when daemon.payload is missing', async () => {
  const value = await buildCuaStatus(resolveConfig())
  assertLossless(value)
  JSON.parse(JSON.stringify(value))
  assert.equal(value.plugin, 'dsh-cuadrive-mac')
  assert.equal(value.pluginVersion, '0.2.0')
  assert.equal(value.lockedDriver, '0.20.0')
  assert.equal(value.lockedSkill, '0.20.0')
  const runtime = value.runtime as Record<string, unknown>
  assert.equal(runtime.plugin, '0.2.0')
  assert.equal(runtime.driver, '0.20.0')
  assert.equal(typeof runtime.percent, 'number')
  assert.equal(typeof runtime.statusPath, 'string')
  const hostPermissions = value.hostPermissions as Record<string, unknown>
  assert.equal(typeof hostPermissions.accessibility, 'boolean')
  assert.equal(typeof hostPermissions.screenRecording, 'boolean')
  assert.equal(typeof hostPermissions.hostLabel, 'string')
  assert.ok(hostPermissions.hostKind === 'app' || hostPermissions.hostKind === 'cli')
  assert.equal(typeof runtime.logPath, 'string')
  assert.equal(typeof runtime.manualCachePath, 'string')
  assert.equal(runtime.resumable, true)
})
