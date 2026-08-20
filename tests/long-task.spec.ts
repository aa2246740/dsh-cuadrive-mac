import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.ts'
import { callDriverTool } from '../src/driver.ts'
import { ensureRuntimeSync } from '../src/runtime.ts'
import { buildCuaStatus } from '../src/status.ts'
import { invokeCuaTool } from '../src/tools.ts'
import { looksLikeAxTimeout } from '../src/window-state.ts'

function fakeCtx(): Context {
  return { get: () => undefined } as unknown as Context
}

function isCuaSelfWindow(window: { app_name?: string, title?: string }): boolean {
  return /cua[\s._-]*driver/i.test(`${window.app_name ?? ''} ${window.title ?? ''}`)
}

function lossless(value: unknown, path = '$'): void {
  if (value === undefined) assert.fail(`${path} is undefined`)
  JSON.parse(JSON.stringify(value))
}

test('long GUI loop: hosted session + status + snapshots stay lossless for 90s', async (t) => {
  let config
  try {
    const binary = ensureRuntimeSync(resolveConfig())
    config = resolveConfig({ timeoutMs: 45_000, sessionId: 'dsh-long-task', heartbeatMs: 15_000, binary })
  } catch (error: unknown) {
    t.skip(error instanceof Error ? error.message : String(error))
    return
  }
  const windows = await callDriverTool(config, 'list_windows', {}) as {
    windows?: Array<{ pid?: number, window_id?: number, is_on_screen?: boolean, app_name?: string }>
  }
  const target = (windows.windows ?? []).find(window =>
    window.is_on_screen === true
    && typeof window.pid === 'number'
    && typeof window.window_id === 'number'
    && !isCuaSelfWindow(window),
  )

  const started = Date.now()
  let rounds = 0
  while (Date.now() - started < 90_000) {
    rounds += 1
    const status = await buildCuaStatus(config)
    lossless(status)
    assert.equal(status.hostedSession, 'dsh-long-task')

    const apps = await invokeCuaTool(fakeCtx(), config, 'list_apps', {})
    lossless(apps)
    assert.equal(/ENOENT/.test(apps.text), false)

    const listed = await invokeCuaTool(fakeCtx(), config, 'list_windows', {})
    lossless(listed)
    assert.equal(looksLikeAxTimeout(listed.data), false)

    if (target?.pid !== undefined && target.window_id !== undefined) {
      const shot = await invokeCuaTool(fakeCtx(), config, 'get_window_state', {
        pid: target.pid,
        window_id: target.window_id,
      })
      lossless(shot)
      assert.equal(looksLikeAxTimeout(shot.data), false, shot.text.slice(0, 200))
      assert.equal(/ENOENT/.test(shot.text), false)
    }

    await new Promise(resolve => setTimeout(resolve, 8_000))
  }

  assert.ok(rounds >= 6, `expected at least 6 long-task rounds, got ${rounds}`)
})
