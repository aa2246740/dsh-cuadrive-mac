import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { loadRuntimeLock } from '../src/runtime.ts'
import { resolveSkillDir } from '../src/skill.ts'

test('skill dir is the plugin-vendored pack, not cua-driver skills path', () => {
  const dir = resolveSkillDir(resolveConfig())
  const pluginRoot = join(fileURLToPath(new URL('..', import.meta.url)))
  assert.equal(dir, join(pluginRoot, 'skill'))
  assert.ok(existsSync(join(dir, 'SKILL.md')))
  const body = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  assert.match(body, /version:\s*0\.20\.0/)
  assert.match(body, new RegExp(`version:\\s*${loadRuntimeLock().skill}`))
  assert.ok(!dir.includes('.cua-driver/skills'))
})
