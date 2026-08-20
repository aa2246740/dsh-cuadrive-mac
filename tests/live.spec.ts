import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.ts'
import { callDriverTool } from '../src/driver.ts'
import { ensureRuntimeSync } from '../src/runtime.ts'
import { cuaCallValue } from '../src/result.ts'
import { invokeCuaTool } from '../src/tools.ts'
import { looksLikeAxTimeout } from '../src/window-state.ts'

function fakeCtx(): Context {
  return { get: () => undefined } as unknown as Context
}

function lossless(value: unknown): void {
  const encoded = JSON.stringify(value)
  assert.ok(encoded, 'value must stringify')
  JSON.parse(encoded)
}

async function notesTarget(config: ReturnType<typeof resolveConfig>): Promise<{ pid: number, window_id: number } | undefined> {
  const listed = await callDriverTool(config, 'list_windows', {}) as {
    windows?: Array<{ pid?: number, window_id?: number, app_name?: string, title?: string, is_on_screen?: boolean }>
  }
  const hit = (listed.windows ?? []).find(window =>
    window.app_name === '备忘录'
    && window.is_on_screen === true
    && typeof window.pid === 'number'
    && typeof window.window_id === 'number',
  )
  if (!hit?.pid || !hit.window_id) return undefined
  return { pid: hit.pid, window_id: hit.window_id }
}

function liveConfig(timeoutMs: number) {
  const binary = ensureRuntimeSync(resolveConfig())
  return resolveConfig({ timeoutMs, binary })
}

test('live: daemon, list_apps, and list_windows are JSON and fast', async (t) => {
  let config
  try {
    config = liveConfig(30_000)
  } catch (error: unknown) {
    t.skip(error instanceof Error ? error.message : String(error))
    return
  }
  const apps = await callDriverTool(config, 'list_apps', {})
  lossless(apps)
  assert.ok(apps && typeof apps === 'object')
  const windows = await callDriverTool(config, 'list_windows', {})
  lossless(windows)
})

test('live: Notes get_window_state via invokeCuaTool does not timeout or mention ENOENT', async (t) => {
  let config
  try {
    config = liveConfig(45_000)
  } catch (error: unknown) {
    t.skip(error instanceof Error ? error.message : String(error))
    return
  }
  const target = await notesTarget(config)
  if (!target) {
    t.skip('Notes is not on screen — open 备忘录 to run this case')
    return
  }
  const started = Date.now()
  const value = await invokeCuaTool(fakeCtx(), config, 'get_window_state', {
    pid: target.pid,
    window_id: target.window_id,
  })
  const elapsed = Date.now() - started
  lossless(value)
  lossless(cuaCallValue(value.tool, value.data, { images: value.images }))
  assert.equal(value.tool, 'get_window_state')
  assert.equal(looksLikeAxTimeout(value.data), false, value.text.slice(0, 240))
  assert.equal(/ENOENT/.test(value.text), false, value.text.slice(0, 240))
  assert.ok(elapsed < 25_000, `bounded snapshot took ${elapsed}ms`)
  const data = value.data as { element_count?: number, elements?: unknown[] }
  assert.ok((data.element_count ?? 0) > 0 || (data.elements?.length ?? 0) > 0, 'expected a bounded AX tree')
})
