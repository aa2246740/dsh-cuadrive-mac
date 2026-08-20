import assert from 'node:assert/strict'
import test from 'node:test'
import { cliArgs, defaultSocketPath } from '../src/argv.ts'
import { resolveConfig } from '../src/config.ts'

test('cliArgs pins every invocation to the DSH socket', () => {
  const config = resolveConfig()
  assert.match(config.socketPath, /dsh-cuadrive-mac[/\\]run[/\\]driver\.sock$/)
  assert.deepEqual(cliArgs(config, ['call', 'click', '{}']), ['--socket', config.socketPath, 'call', 'click', '{}'])
  assert.deepEqual(cliArgs(config, ['stop']), ['--socket', config.socketPath, 'stop'])
  assert.ok(cliArgs(config, ['stop'])[0] === '--socket')
})

test('cliArgs refuses a shared stop when the socket path is missing', () => {
  assert.throws(
    () => cliArgs({ ownDaemon: true, socketPath: '' }, ['stop']),
    /refusing to talk to the shared cua-driver socket/,
  )
})

test('defaultSocketPath is under DSH home, not the shared cua-driver cache', () => {
  const path = defaultSocketPath()
  assert.ok(!path.includes('Library/Caches/cua-driver'))
  assert.match(path, /dsh-cuadrive-mac[/\\]run[/\\]driver\.sock$/)
})
