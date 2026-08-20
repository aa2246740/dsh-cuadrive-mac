import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cliArgs, defaultSocketPath, pluginHome } from '../src/argv.ts'
import { resolveBinary } from '../src/binary.ts'
import { resolveConfig } from '../src/config.ts'
import { serveLaunch } from '../src/daemon.ts'
import {
  classifyDownloadError,
  curlDownloadArgs,
  downloadLogPath,
  ensureRuntimeSync,
  isSharedCuaInstall,
  loadRuntimeLock,
  parseCurlProgress,
  manualCachePath,
  proxyHint,
  readRuntimeStatus,
  releaseArtifact,
  resolvedProxy,
  runtimeAvailable,
  statusPath,
  vendorDir,
  vendorStampBody,
  writeRuntimeStatus,
} from '../src/runtime.ts'

test('runtime lock pins plugin, driver, skill, and checksums together', () => {
  const lock = loadRuntimeLock()
  assert.equal(lock.plugin, '0.2.0')
  assert.equal(lock.driver, '0.20.0')
  assert.equal(lock.skill, '0.20.0')
  assert.equal(lock.driverTag, 'cua-driver-rs-v0.20.0')
  assert.equal(
    lock.artifacts['darwin-universal-binary']?.sha256,
    '07a88ea2c28a9ead66b2d9f6f93fab4b1189a1f7c704d2cd7b6d12c30eee9984',
  )
  assert.equal(lock.artifacts['darwin-universal-binary']?.bytes, 40625908)
})

test('vendor dir follows the locked driver version, not whatever is on PATH', () => {
  const lock = loadRuntimeLock()
  const dir = vendorDir()
  assert.match(dir, new RegExp(`${lock.driver}$`))
  assert.ok(dir.startsWith(pluginHome()))
})

test('releaseArtifact pins official 0.20.0 darwin tarball and refuses other OSes', () => {
  assert.equal(releaseArtifact('darwin', 'arm64').name, 'cua-driver-rs-0.20.0-darwin-universal-binary.tar.gz')
  assert.equal(releaseArtifact('darwin', 'x64').name, 'cua-driver-rs-0.20.0-darwin-universal-binary.tar.gz')
  assert.match(releaseArtifact('darwin', 'arm64').sha256, /^[0-9a-f]{64}$/)
  assert.throws(() => releaseArtifact('linux', 'x64'), /macOS only/)
  assert.throws(() => releaseArtifact('win32', 'x64'), /macOS only/)
})

test('plugin home and socket live under DSH, never the shared cua-driver cache or Applications', () => {
  const home = pluginHome()
  const socket = defaultSocketPath()
  assert.match(home, /dsh-cuadrive-mac$/)
  assert.ok(socket.startsWith(home))
  assert.equal(isSharedCuaInstall('/Applications/CuaDriver.app/Contents/MacOS/cua-driver'), true)
  assert.equal(isSharedCuaInstall(join(process.env.HOME ?? '', '.local/bin/cua-driver')), true)
  assert.equal(isSharedCuaInstall('/Users/x/Library/Caches/cua-driver/cua-driver.sock'), true)
  assert.equal(isSharedCuaInstall(socket), false)
})

test('resolveBinary does not fall back to the machine cua-driver', () => {
  const config = resolveConfig()
  assert.equal(config.binary, '')
  let path = ''
  try {
    path = resolveBinary('')
  } catch (error: unknown) {
    assert.match(error instanceof Error ? error.message : String(error), /runtime is not installed/)
  }
  if (path.length > 0) assert.equal(isSharedCuaInstall(path), false)
  const explicit = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'
  assert.equal(resolveBinary(explicit), explicit)
})

test('serveLaunch uses embedded mode on the DSH socket and never open -a CuaDriver', () => {
  const config = resolveConfig({ socketPath: '/tmp/dsh-cuadrive-mac-test.sock' })
  const launch = serveLaunch(config, '/opt/dsh-cuadrive-mac/cua-driver')
  assert.equal(launch.command, '/opt/dsh-cuadrive-mac/cua-driver')
  assert.deepEqual(launch.args, ['--socket', '/tmp/dsh-cuadrive-mac-test.sock', 'serve', '--embedded', '--no-permissions-gate'])
  assert.equal(launch.env.CUA_DRIVER_EMBEDDED, '1')
  assert.equal(launch.args.includes('CuaDriver'), false)
  assert.equal(launch.args.includes('grant'), false)
})

test('cliArgs stop cannot target the shared daemon', () => {
  const config = resolveConfig({ socketPath: '/tmp/dsh-cuadrive-mac-test.sock' })
  assert.deepEqual(cliArgs(config, ['stop']), ['--socket', '/tmp/dsh-cuadrive-mac-test.sock', 'stop'])
})

test('curl download resumes, retries, and stays visible (no silent -s)', () => {
  const args = curlDownloadArgs('https://example.invalid/driver.tgz', '/tmp/driver.tgz.part')
  assert.ok(args.includes('-C') && args.includes('-'))
  assert.ok(args.includes('-L'))
  assert.ok(args.includes('--fail'))
  assert.ok(args.includes('--retry'))
  assert.ok(args.includes('--progress-bar'))
  assert.ok(!args.includes('-s'))
  assert.ok(!args.includes('-fsSL'))
})

test('curl download uses an explicit proxy when given', () => {
  const args = curlDownloadArgs('https://example.invalid/driver.tgz', '/tmp/driver.tgz.part', 'http://127.0.0.1:7890')
  assert.ok(args.includes('-x'))
  assert.ok(args.includes('http://127.0.0.1:7890'))
})

test('runtime status is lossless JSON and tells the user how to proxy or drop in the file', () => {
  const status = readRuntimeStatus()
  JSON.parse(JSON.stringify(status))
  assert.ok(status.phase === 'missing' || status.phase === 'ready' || status.phase === 'downloading' || status.phase === 'error' || status.phase === 'verifying' || status.phase === 'extracting')
  assert.equal(status.plugin, '0.2.0')
  assert.equal(status.driver, '0.20.0')
  assert.equal(typeof status.percent, 'number')
  assert.match(status.manualCachePath, /dsh-cuadrive-mac/)
  assert.equal(status.manualCachePath, manualCachePath())
  assert.equal(status.statusPath, statusPath())
  assert.equal(status.logPath, downloadLogPath())
  assert.equal(status.resumable, true)
  assert.match(status.artifactUrl, /github.com\/trycua\/cua\/releases/)
  assert.match(proxyHint(), /HTTPS_PROXY/)
  assert.match(status.hint, /HTTPS_PROXY|ready|Downloading|download|pinned/i)
})

test('vendor stamp locks plugin version together with driver sha256', () => {
  const lock = loadRuntimeLock()
  const sha = lock.artifacts['darwin-universal-binary']?.sha256 ?? ''
  assert.match(vendorStampBody(lock, sha), /^0\.2\.0 0\.20\.0 [0-9a-f]{64}$/)
})

test('resolvedProxy prefers plugin config over env', () => {
  assert.equal(resolvedProxy({ proxy: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890')
})

test('classifyDownloadError points at 梯子 when GitHub cannot be reached', () => {
  assert.match(classifyDownloadError('Failed to connect to github.com port 443: Connection timed out'), /HTTPS_PROXY|梯子/)
  assert.match(classifyDownloadError('curl: (56) CONNECT tunnel failed, response 407'), /[Pp]roxy/)
})

test('writeRuntimeStatus is visible on disk and lossless', () => {
  const prev = process.env.DSH_HOME
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cua-status-'))
  process.env.DSH_HOME = tmp
  try {
    const status = writeRuntimeStatus({
      phase: 'downloading',
      percent: 42,
      bytes: 17_000_000,
      message: 'Downloading cua-driver 0.20.0',
    })
    assert.equal(status.percent, 42)
    assert.equal(status.plugin, '0.2.0')
    assert.equal(status.driver, '0.20.0')
    const disk = JSON.parse(readFileSync(statusPath(), 'utf8')) as { percent: number, phase: string }
    assert.equal(disk.percent, 42)
    assert.equal(disk.phase, 'downloading')
    JSON.parse(JSON.stringify(disk))
  } finally {
    process.env.DSH_HOME = prev
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runtimeAvailable is false in an empty DSH home', () => {
  const prev = process.env.DSH_HOME
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cua-empty-'))
  process.env.DSH_HOME = tmp
  try {
    assert.equal(runtimeAvailable(resolveConfig({ binary: '', autoStart: false })), false)
  } finally {
    process.env.DSH_HOME = prev
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('plugin config schema includes proxy', () => {
  assert.equal(resolveConfig().proxy, '')
  assert.equal(resolveConfig({ proxy: ' http://127.0.0.1:7890 ' }).proxy, 'http://127.0.0.1:7890')
})

test('ensureRuntimeSync does not block on curl when vendor is missing', () => {
  const prev = process.env.DSH_HOME
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cua-sync-'))
  process.env.DSH_HOME = tmp
  try {
    assert.throws(
      () => ensureRuntimeSync(resolveConfig({ autoStart: false, binary: '' })),
      /runtime is not installed/,
    )
  } finally {
    process.env.DSH_HOME = prev
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('parseCurlProgress reads the last percent from a progress bar', () => {
  assert.equal(parseCurlProgress('######################## 100.0%'), 100)
  assert.equal(parseCurlProgress('#=#=-  42.3%  \n###### 81.0%'), 81)
  assert.equal(parseCurlProgress('no meter'), 0)
})
