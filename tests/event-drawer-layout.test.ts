import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  'src/renderer/src/components/event-center/EventDetailDrawer.vue',
  'utf8'
)

test('event drawer header wraps actions below the title on a narrow drawer', () => {
  const header = source.slice(source.indexOf('.drawer__header {'), source.indexOf('.drawer__heading {'))
  assert.match(header, /flex-wrap:\s*wrap/)
  assert.match(header, /gap:\s*var\(--space-3\)/)
})

test('event drawer heading keeps a usable title width', () => {
  const heading = source.slice(source.indexOf('.drawer__heading {'), source.indexOf('.drawer__severity {'))
  assert.match(heading, /flex:\s*1 1 280px/)
  assert.match(heading, /min-width:\s*0/)
  const actions = source.slice(source.indexOf('.drawer__header-actions {'), source.indexOf('.drawer__action-form {'))
  assert.match(actions, /flex:\s*0 0 auto/)
  assert.match(actions, /margin-left:\s*auto/)
})
