import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { describeDriverTool, listDriverTools, normalizeDriverOutput } from '../src/driver.ts'
import { findVendorBinary } from '../src/runtime.ts'
import { sanitizeJsonSchema } from '../src/parse.ts'
import { compactWindowStateData } from '../src/window-state.ts'

test('normalizeDriverOutput wraps AX timeout plaintext', () => {
  const raw = 'AX tree walk for pid=43107 timed out after 20 s. The app (likely Arc, Electron, or Safari with many tabs) has a pathologically large accessibility tree.'
  assert.deepEqual(normalizeDriverOutput(raw), { text: raw })
})

test('normalizeDriverOutput parses JSON objects', () => {
  assert.deepEqual(normalizeDriverOutput('note\n{"pid":1}\n'), { pid: 1 })
})

test('every installed driver tool describe() sanitizes to an object schema', (t) => {
  const binary = findVendorBinary()
    ?? (existsSync('/Applications/CuaDriver.app/Contents/MacOS/cua-driver')
      ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'
      : undefined)
  if (!binary) {
    t.skip('no cua-driver binary available for describe()')
    return
  }
  const config = resolveConfig({ binary })
  const listed = listDriverTools(config)
  assert.ok(listed.length >= 20, `expected a full tool list, got ${listed.length}`)
  for (const tool of listed) {
    const described = describeDriverTool(config, tool.name)
    const schema = sanitizeJsonSchema(described.inputSchema)
    assert.equal(typeof schema, 'object')
    assert.ok(!JSON.stringify(schema).includes('"minimum"'), tool.name)
  }
})

test('compactWindowStateData drops bulky keys and long markdown', () => {
  const compact = compactWindowStateData({
    element_count: 2,
    elements: [
      { element_index: 0, role: 'AXWindow', label: '备忘录', parent_index: null, depth: 0, extra: 1 },
    ],
    tree_markdown: 'x'.repeat(7000),
  }) as { elements: Array<Record<string, unknown>>, tree_markdown: string }
  assert.equal(compact.elements[0].label, '备忘录')
  assert.equal(compact.elements[0].extra, undefined)
  assert.ok(compact.tree_markdown.length < 7000)
  assert.match(compact.tree_markdown, /truncated/)
})
