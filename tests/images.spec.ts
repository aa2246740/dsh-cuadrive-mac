import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { collectImages, wantsScreenshotFile } from '../src/images.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function ctx(): Context {
  return { get: () => undefined } as unknown as Context
}

test('wantsScreenshotFile respects include_screenshot and explicit out path', () => {
  assert.equal(wantsScreenshotFile('get_window_state', {}), true)
  assert.equal(wantsScreenshotFile('get_window_state', { include_screenshot: false }), false)
  assert.equal(wantsScreenshotFile('get_window_state', { screenshot_out_file: '/tmp/x.png' }), false)
  assert.equal(wantsScreenshotFile('click', {}), false)
})

test('collectImages swallows missing screenshot files', async () => {
  const result = await collectImages(ctx(), 'get_window_state', { ok: true }, join(tmpdir(), 'does-not-exist-cua.png'))
  assert.deepEqual(result.images, [])
  assert.equal(result.notes.some(note => /ENOENT/.test(note)), false)
})

test('collectImages commits a real PNG when attachments are absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-img-'))
  const path = join(dir, 'shot.png')
  await writeFile(path, PNG)
  const result = await collectImages(ctx(), 'get_window_state', {}, path)
  assert.equal(result.images.length, 0)
  assert.match(result.notes.join('\n'), /read_image/)
})
