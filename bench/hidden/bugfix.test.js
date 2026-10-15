import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start } from './helpers.js'

test('bug1: dueBefore includes tasks due on that day', async () => {
  const { api, close } = await start()
  try {
    for (const [title, due] of [['before', '2026-10-14'], ['same', '2026-10-15'], ['after', '2026-10-16'], ['none', null]])
      await api('/tasks', { method: 'POST', body: { title, due } })
    const r = await api('/tasks?dueBefore=2026-10-15')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.items.map(t => t.title).sort(), ['before', 'same'])
  } finally { await close() }
})

test('bug2: total counts filtered tasks, across pages and filter combos', async () => {
  const { api, close } = await start()
  try {
    const ids = []
    for (let i = 0; i < 6; i++) {
      const r = await api('/tasks', { method: 'POST', body: { title: `t${i}`, tags: i < 3 ? ['work'] : ['home'], due: `2026-01-0${i + 1}` } })
      ids.push(r.body.id)
    }
    await api(`/tasks/${ids[0]}`, { method: 'PATCH', body: { status: 'done' } })
    assert.equal((await api('/tasks?tag=work')).body.total, 3)
    const paged = (await api('/tasks?tag=work&page=2&pageSize=2')).body
    assert.equal(paged.total, 3)
    assert.equal(paged.items.length, 1)
    assert.equal((await api('/tasks?tag=work&status=done')).body.total, 1)
    assert.equal((await api('/tasks?dueBefore=2026-01-02')).body.total, 2)
    assert.equal((await api('/tasks?tag=nothing')).body.total, 0)
    assert.equal((await api('/tasks')).body.total, 6)
  } finally { await close() }
})

for (const [name, patch] of [
  ['id', { id: 'abc' }],
  ['createdAt', { createdAt: '2000-01-01T00:00:00.000Z' }],
  ['updatedAt', { updatedAt: '2000-01-01T00:00:00.000Z' }],
  ['unknown field', { color: 'red' }],
  ['allowed plus forbidden field', { title: 'renamed', id: 'abc' }],
]) {
  test(`bug3: PATCH rejects ${name} and leaves the task unchanged`, async () => {
    const { api, close } = await start()
    try {
      const created = (await api('/tasks', { method: 'POST', body: { title: 'orig', tags: ['a'] } })).body
      const r = await api(`/tasks/${created.id}`, { method: 'PATCH', body: patch })
      assert.equal(r.status, 400)
      assert.equal(r.body.error, 'validation')
      const after = await api(`/tasks/${created.id}`)
      assert.equal(after.status, 200)
      assert.deepEqual(after.body, created)
      assert.equal((await api('/tasks/abc')).status, 404)
    } finally { await close() }
  })
}

test('bug3: valid PATCH still works and touches updatedAt only', async () => {
  const { api, close } = await start()
  try {
    const created = (await api('/tasks', { method: 'POST', body: { title: 'orig' } })).body
    const r = await api(`/tasks/${created.id}`, { method: 'PATCH', body: { title: 'new', due: '2026-02-02', tags: ['x'], status: 'done' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.id, created.id)
    assert.equal(r.body.createdAt, created.createdAt)
    assert.deepEqual([r.body.title, r.body.due, r.body.tags, r.body.status], ['new', '2026-02-02', ['x'], 'done'])
    assert.equal((await api(`/tasks/${created.id}`, { method: 'PATCH', body: { status: 'archived' } })).status, 400)
  } finally { await close() }
})

test('regression: pagination, status filter, delete still work', async () => {
  const { api, close } = await start()
  try {
    const ids = []
    for (let i = 0; i < 5; i++) ids.push((await api('/tasks', { method: 'POST', body: { title: `t${i}` } })).body.id)
    const p2 = (await api('/tasks?page=2&pageSize=2')).body
    assert.equal(p2.items.length, 2)
    assert.equal(p2.total, 5)
    assert.equal((await api(`/tasks/${ids[1]}`, { method: 'DELETE' })).status, 204)
    assert.equal((await api('/tasks')).body.total, 4)
    assert.equal((await api('/tasks', { key: 'bad' })).status, 401)
  } finally { await close() }
})
