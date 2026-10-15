import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../src/store.js'

test('returned tasks are copies', () => {
  const store = new TaskStore()
  const t = store.create({ title: 'a', tags: ['x'] })
  t.tags.push('y')
  assert.deepEqual(store.get(t.id).tags, ['x'])
})

test('filters by tag and status', () => {
  const store = new TaskStore()
  store.create({ title: 'a', tags: ['work'] })
  const b = store.create({ title: 'b', tags: ['home'] })
  store.update(b.id, { status: 'done' })
  assert.deepEqual(store.list({ tag: 'work' }).items.map(t => t.title), ['a'])
  assert.deepEqual(store.list({ status: 'done' }).items.map(t => t.title), ['b'])
})

test('dueBefore keeps tasks due earlier', () => {
  const store = new TaskStore()
  store.create({ title: 'early', due: '2026-01-01' })
  store.create({ title: 'late', due: '2026-12-31' })
  store.create({ title: 'none' })
  assert.deepEqual(store.list({ dueBefore: '2026-06-01' }).items.map(t => t.title), ['early'])
})
