import assert from 'node:assert/strict'
import test from 'node:test'
import { attachPluginSession, endedSessionId, sessionToRefresh } from '../src/session-revive.ts'

test('parses the exact cua-driver error from session-6705', () => {
  const message = "session 'tokyo-ppt' has ended; tool call 'click' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."
  assert.equal(endedSessionId(message), 'tokyo-ppt')
})

test('returns undefined for unrelated driver errors', () => {
  assert.equal(endedSessionId('AX tree walk for pid=43107 timed out after 20 s.'), undefined)
})

test('sessionToRefresh reads a named session', () => {
  assert.equal(sessionToRefresh({ session: 'tokyo-ppt', pid: 1524 }), 'tokyo-ppt')
  assert.equal(sessionToRefresh({ pid: 1524 }), undefined)
})

test('attachPluginSession hosts a DSH session when the model omits one', () => {
  assert.deepEqual(attachPluginSession({ pid: 1 }, 'dsh'), { pid: 1, session: 'dsh' })
  assert.deepEqual(attachPluginSession({ session: 'tokyo-ppt', pid: 1 }, 'dsh'), { session: 'tokyo-ppt', pid: 1 })
})
