import assert from 'node:assert/strict'
import test from 'node:test'
import { compactListAppsData } from '../src/compact-apps.ts'

test('compactListAppsData drops empty windows arrays from session-6705 list_apps', () => {
  const compact = compactListAppsData({
    apps: [
      { name: 'WPS Office', pid: 1524, running: true, windows: [] },
      { name: '备忘录', pid: 43107, running: true, windows: [{ window_id: 1 }] },
    ],
  }) as { apps: Array<{ windows?: unknown[] }> }
  assert.equal(compact.apps[0].windows, undefined)
  assert.deepEqual(compact.apps[1].windows, [{ window_id: 1 }])
  JSON.parse(JSON.stringify(compact))
})
