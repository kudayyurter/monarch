import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../src/store.js'
import { createServer } from '../src/server.js'

let server, base
const KEY = 'k1'

before(async () => {
  server = createServer({ store: new TaskStore(), keys: [KEY] })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const api = (path, { method = 'GET', body, key = KEY } = {}) =>
  fetch(base + path, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })

test('rejects missing or wrong api key', async () => {
  assert.equal((await api('/tasks', { key: '' })).status, 401)
  assert.equal((await api('/tasks', { key: 'nope' })).status, 401)
})

test('create, get, patch, delete a task', async () => {
  const created = await (await api('/tasks', { method: 'POST', body: { title: 'write docs', tags: ['docs'] } })).json()
  assert.equal(created.title, 'write docs')
  assert.equal(created.status, 'open')

  const got = await (await api(`/tasks/${created.id}`)).json()
  assert.deepEqual(got, created)

  const patched = await api(`/tasks/${created.id}`, { method: 'PATCH', body: { status: 'done' } })
  assert.equal(patched.status, 200)
  assert.equal((await patched.json()).status, 'done')

  assert.equal((await api(`/tasks/${created.id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await api(`/tasks/${created.id}`)).status, 404)
})

test('validates bodies and query params', async () => {
  assert.equal((await api('/tasks', { method: 'POST', body: { title: '' } })).status, 400)
  assert.equal((await api('/tasks', { method: 'POST', body: { title: 'x', due: 'tomorrow' } })).status, 400)
  assert.equal((await api('/tasks?pageSize=500')).status, 400)
  assert.equal((await api('/tasks?dueBefore=soon')).status, 400)
})

test('lists with pagination', async () => {
  for (let i = 0; i < 3; i++) await api('/tasks', { method: 'POST', body: { title: `t${i}` } })
  const res = await (await api('/tasks?page=1&pageSize=2')).json()
  assert.equal(res.items.length, 2)
  assert.equal(res.page, 1)
})
