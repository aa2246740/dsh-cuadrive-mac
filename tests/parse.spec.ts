import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { extractJson, parseDescribe, parseFrontmatter, parseListTools, sanitizeJsonSchema } from '../src/parse.ts'
import { boundWindowStateArgs, looksLikeAxTimeout, shouldRetryWindowState } from '../src/window-state.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('parseListTools reads name: summary lines', () => {
  const listed = parseListTools('click: Click a target\nget_window_state: Snapshot a window\n')
  assert.deepEqual(listed.map(item => item.name), ['click', 'get_window_state'])
})

test('parseDescribe reads name, description, and JSON schema after input_schema', () => {
  const described = parseDescribe(`name: click

description:
Prefer element_index. frame: {x,y,w,h} is not the schema.

input_schema:
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "pid": { "type": "integer", "minimum": 1 }
  }
}
`)
  assert.equal(described.name, 'click')
  assert.match(described.description, /element_index/)
  assert.equal((described.inputSchema.properties as { pid: unknown }).pid !== undefined, true)
})

test('sanitizeJsonSchema drops minimum and keeps additionalProperties boolean', () => {
  const cleaned = sanitizeJsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      pid: { type: 'integer', minimum: 1, description: 'pid' },
    },
    required: ['pid', 'missing'],
  })
  assert.deepEqual(cleaned.required, ['pid'])
  assert.equal((cleaned.properties as { pid: { minimum?: number } }).pid.minimum, undefined)
  assert.equal((cleaned.properties as { pid: { description?: string } }).pid.description, 'pid')
})

test('extractJson skips prose before the first object', () => {
  assert.deepEqual(extractJson('note: wait\n{"ok": true}\n'), { ok: true })
})

test('looksLikeAxTimeout matches cua-driver Notes/iCloud failure text', () => {
  const data = {
    text: 'AX tree walk for pid=43107 timed out after 20 s. The app (likely Arc, Electron, or Safari with many tabs) has a pathologically large accessibility tree.',
  }
  assert.equal(looksLikeAxTimeout(data), true)
  assert.equal(shouldRetryWindowState({}, data), true)
  assert.equal(shouldRetryWindowState({ max_elements: 200, max_depth: 8 }, data), false)
})

test('boundWindowStateArgs fills omitted caps and keeps caller caps', () => {
  const filled = boundWindowStateArgs({ pid: 1, window_id: 2 })
  assert.equal(filled.max_elements, 200)
  assert.equal(filled.max_depth, 8)
  const kept = boundWindowStateArgs({ pid: 1, max_elements: 50, max_depth: 3 }, true)
  assert.equal(kept.max_elements, 50)
  assert.equal(kept.max_depth, 3)
})

test('vendored SKILL.md is the official cua-driver skill, not a condensed rewrite', () => {
  const raw = readFileSync(join(pluginRoot, 'skill/SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed.name, 'cua-driver')
  assert.match(parsed.description ?? '', /native GUI/)
  assert.match(parsed.body, /The core invariant/)
  assert.match(parsed.body, /snapshot before/)
  assert.ok(raw.length > 50_000, `official SKILL.md should stay large, got ${raw.length}`)
  for (const companion of ['MACOS.md', 'WINDOWS.md', 'LINUX.md', 'BROWSER.md', 'RECORDING.md']) {
    const text = readFileSync(join(pluginRoot, 'skill', companion), 'utf8')
    assert.ok(text.length > 1000, companion)
  }
})
