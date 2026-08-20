import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('ships an installable DSH bundle with a portable inventory name', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    dsh?: { bundle?: { patch?: string } }
  }
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, 'dsh-cua-drive')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.match(patch, /id: dsh-cuadrive-mac/)
  assert.match(patch, /name: dsh-cua-drive/)
  assert.doesNotMatch(patch, /\/Users\/|[A-Z]:\\/)
})

test('prebuilt package assets are present after build', () => {
  assert.equal(existsSync(join(root, 'lib/index.mjs')), true)
  assert.equal(existsSync(join(root, 'lib/host-tcc-prompt.c')), true)
})
