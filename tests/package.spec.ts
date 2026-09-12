import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const STOCK_ADD = 'dsh plugin --profile web add github:aa2246740/dsh-cuadrive-mac'

function firstShFence(markdown: string): string {
  const match = markdown.match(/```sh\n([\s\S]*?)\n```/)
  assert.ok(match?.[1], 'README must open with a sh command fence')
  return match[1].trim()
}

test('ships an installable DSH bundle with a portable inventory name', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    files?: string[]
    scripts?: { prepare?: string }
    dsh?: { bundle?: { patch?: string } }
  }
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, 'dsh-cua-drive')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.scripts?.prepare, undefined)
  assert.ok(manifest.files?.includes('lib'))
  assert.match(patch, /id: dsh-cuadrive-mac/)
  assert.match(patch, /name: dsh-cua-drive/)
  assert.doesNotMatch(patch, /\/Users\/|[A-Z]:\\/)
})

test('READMEs lead with the official stock dsh plugin add', () => {
  const zh = readFileSync(join(root, 'README.md'), 'utf8')
  const en = readFileSync(join(root, 'README.en.md'), 'utf8')
  assert.equal(firstShFence(zh), STOCK_ADD)
  assert.equal(firstShFence(en), STOCK_ADD)
  assert.match(zh, /pnpm/)
  assert.match(en, /pnpm/)
  assert.doesNotMatch(zh, /dshx |my-plugins\/|DSHX_HARNESS/)
  assert.doesNotMatch(en, /dshx |my-plugins\/|DSHX_HARNESS/)
})

test('prebuilt package assets are present after build', () => {
  assert.equal(existsSync(join(root, 'lib/index.mjs')), true)
  assert.equal(existsSync(join(root, 'lib/host-tcc-prompt.c')), true)
})
