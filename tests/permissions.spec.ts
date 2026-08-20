import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { serveLaunch } from '../src/daemon.ts'
import { parsePlistBundleId, parsePlistString } from '../src/host-id.ts'
import {
  ACCESSIBILITY_SETTINGS_URL,
  SCREEN_RECORDING_SETTINGS_URL,
  TCC_PROMPT_SOURCE,
  ensureHostPermissions,
  grantHint,
  parseTccPromptOutput,
  tccPromptClangArgs,
} from '../src/permissions.ts'

test('first-launch TCC helper source ships with the plugin', () => {
  assert.ok(existsSync(TCC_PROMPT_SOURCE))
})

test('clang args compile a host helper, never CuaDriver.app', () => {
  const dest = '/tmp/dsh-host-tcc-prompt'
  const args = tccPromptClangArgs(TCC_PROMPT_SOURCE, dest)
  assert.ok(args.includes('-framework'))
  assert.ok(args.includes('ApplicationServices'))
  assert.ok(args.includes('CoreGraphics'))
  assert.equal(args.at(-2), dest)
  assert.equal(args.at(-1), TCC_PROMPT_SOURCE)
  assert.ok(!args.some(arg => arg.includes('CuaDriver')))
})

test('parseTccPromptOutput is lossless booleans', () => {
  assert.deepEqual(parseTccPromptOutput('{"accessibility":true,"screenRecording":false}\n'), {
    accessibility: true,
    screenRecording: false,
  })
  assert.equal(parseTccPromptOutput('not json'), undefined)
})

test('ensureHostPermissions can skip prompting', async () => {
  const prev = process.env.DSH_HOME
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cua-perm-'))
  process.env.DSH_HOME = tmp
  try {
    const state = await ensureHostPermissions(resolveConfig({ promptPermissions: false }))
    JSON.parse(JSON.stringify(state))
    assert.equal(state.prompted, false)
    assert.equal(state.accessibility, true)
    assert.equal(state.screenRecording, true)
  } finally {
    process.env.DSH_HOME = prev
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('privacy Settings URLs target DSH grant panes, not CuaDriver', () => {
  assert.match(ACCESSIBILITY_SETTINGS_URL, /Privacy_Accessibility/)
  assert.match(SCREEN_RECORDING_SETTINGS_URL, /Privacy_ScreenCapture/)
})

test('Info.plist parser reads CFBundleIdentifier', () => {
  const xml = '<plist><dict><key>CFBundleIdentifier</key><string>local.dsh.desktop</string><key>CFBundleName</key><string>DSH</string></dict></plist>'
  assert.equal(parsePlistBundleId(xml), 'local.dsh.desktop')
  assert.equal(parsePlistString(xml, 'CFBundleName'), 'DSH')
})

test('CLI dsh without an app pack is told to grant the terminal, not DSH.app', () => {
  const hint = grantHint('Terminal', 'cli', false, false)
  assert.match(hint, /Terminal/)
  assert.match(hint, /no DSH\.app/)
  assert.match(hint, /CuaDriver/)
  const ok = grantHint('Terminal', 'cli', true, true)
  assert.match(ok, /terminal or IDE|Terminal/)
})

test('serveLaunch stays embedded and does not grant via CuaDriver.app', () => {
  const launch = serveLaunch(resolveConfig({ socketPath: '/tmp/dsh-cuadrive-mac-test.sock' }), '/opt/dsh-cuadrive-mac/cua-driver')
  assert.equal(launch.env.CUA_DRIVER_EMBEDDED, '1')
  assert.ok(launch.args.includes('--embedded'))
  assert.ok(launch.args.includes('--no-permissions-gate'))
  assert.ok(!launch.args.includes('grant'))
  assert.ok(!String(launch.command).includes('CuaDriver.app'))
})

test('clang builds the TCC helper (does not run it — running would prompt)', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS only')
    return
  }
  const dest = join(tmpdir(), `dsh-host-tcc-prompt-${process.pid}`)
  const result = spawnSync('clang', tccPromptClangArgs(TCC_PROMPT_SOURCE, dest), { encoding: 'utf8', timeout: 30_000 })
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.ok(existsSync(dest))
  } finally {
    try { unlinkSync(dest) } catch { /* ignore */ }
  }
})
