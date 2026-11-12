import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

describe('camera wall keeps cell assignments across navigation', () => {
  it('store exposes resetSessions and keeps slots', () => {
    const store = read('src/renderer/src/stores/liveWall.ts')
    assert.match(store, /function resetSessions\(\): string\[\]/)
    assert.match(store, /model\.value\.slots\.filter\(\(slot\): slot is string => slot !== null\)/)
    assert.match(store, /resetSessions,/)
  })

  it('wall leaves by resetSessions and resumes assigned cells', () => {
    const wall = read('src/renderer/src/components/CameraVideoWall.vue')
    assert.match(wall, /wall\.resetSessions\(\)/)
    assert.doesNotMatch(wall, /wall\.clearAll\(layout\.value\)/)
    assert.match(wall, /async function resumeAssignedCells\(\): Promise<void>/)
    assert.match(wall, /await resumeAssignedCells\(\)/)
    assert.match(wall, /:title="cellMessage\(cell\) \|\| cellStatusLabel\(cell\)"/)
  })
})
