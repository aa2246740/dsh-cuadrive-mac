import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.ts'
import { findVendorBinary } from '../src/runtime.ts'
import { invokeCuaTool } from '../src/tools.ts'

test('invokeCuaTool rejects names the installed binary does not list', async (t) => {
  const binary = findVendorBinary()
    ?? (existsSync('/Applications/CuaDriver.app/Contents/MacOS/cua-driver')
      ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'
      : undefined)
  if (!binary) {
    t.skip('no cua-driver binary available')
    return
  }
  const config = resolveConfig({ autoStart: false, binary })
  await assert.rejects(
    () => invokeCuaTool({ get: () => undefined } as unknown as Context, config, 'definitely_not_a_tool', {}),
    /unknown driver tool 'definitely_not_a_tool'/,
  )
})

test('invokeCuaTool returns visible download status instead of crashing when vendor is missing', async () => {
  const prev = process.env.DSH_HOME
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cua-missing-'))
  process.env.DSH_HOME = tmp
  try {
    const config = resolveConfig({ autoStart: false, binary: '' })
    const value = await invokeCuaTool({ get: () => undefined } as unknown as Context, config, 'click', {})
    assert.equal(value.tool, 'click')
    const data = value.data as Record<string, unknown>
    assert.equal(data.ok, false)
    assert.equal(data.reason, 'runtime_not_ready')
    const runtime = data.runtime as Record<string, unknown>
    assert.equal(runtime.plugin, '0.2.0')
    assert.equal(runtime.driver, '0.20.0')
    assert.equal(runtime.resumable, true)
    assert.match(value.text, /HTTPS_PROXY|manualCachePath|status/i)
    JSON.parse(JSON.stringify(value))
  } finally {
    process.env.DSH_HOME = prev
    rmSync(tmp, { recursive: true, force: true })
  }
})
