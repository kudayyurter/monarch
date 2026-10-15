import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../src/store.js'
import { createServer } from '../src/server.js'
import { start, fakeClock } from './helpers.js'

async function limited(capacity, refillPerSec) {
  const clock = fakeClock()
  const s = await start({ rateLimit: { capacity, refillPerSec }, clock })
  return { ...s, clock }
}

test('no rateLimit: unchanged behavior, no header', async () => {
  const { api, close } = await start()
  try {
    for (let i = 0; i < 30; i++) {
      const r = await api('/tasks')
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('x-ratelimit-remaining'), null)
    }
  } finally { await close() }
})

test('consumes tokens, reports remaining, then 429 with Retry-After', async () => {
  const { api, close } = await limited(3, 1)
  try {
    const rem = []
    for (let i = 0; i < 3; i++) {
      const r = await api('/tasks')
      assert.equal(r.status, 200)
      rem.push(r.headers.get('x-ratelimit-remaining'))
    }
    assert.deepEqual(rem, ['2', '1', '0'])
    const r = await api('/tasks')
    assert.equal(r.status, 429)
    assert.deepEqual(r.body, { error: 'rate_limited' })
    assert.equal(r.headers.get('retry-after'), '1')
  } finally { await close() }
})

test('429 does not consume a token', async () => {
  const { api, close, clock } = await limited(1, 1)
  try {
    assert.equal((await api('/tasks')).status, 200)
    clock.advance(999)
    for (let i = 0; i < 5; i++) assert.equal((await api('/tasks')).status, 429)
    clock.advance(1)
    const r = await api('/tasks')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-ratelimit-remaining'), '0')
  } finally { await close() }
})

test('Retry-After rounds up the wait for one token', async () => {
  const { api, close, clock } = await limited(1, 0.25)
  try {
    await api('/tasks')
    assert.equal((await api('/tasks')).headers.get('retry-after'), '4')
    clock.advance(1500)
    assert.equal((await api('/tasks')).headers.get('retry-after'), '3')
  } finally { await close() }
})

test('fractional refill and floor of remaining', async () => {
  const { api, close, clock } = await limited(5, 2)
  try {
    for (let i = 0; i < 5; i++) await api('/tasks')
    clock.advance(750)
    const ok = await api('/tasks')
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('x-ratelimit-remaining'), '0')
    const no = await api('/tasks')
    assert.equal(no.status, 429)
    assert.equal(no.headers.get('retry-after'), '1')
  } finally { await close() }
})

test('refill never exceeds capacity', async () => {
  const { api, close, clock } = await limited(2, 10)
  try {
    await api('/tasks'); await api('/tasks')
    clock.advance(3_600_000)
    assert.equal((await api('/tasks')).headers.get('x-ratelimit-remaining'), '1')
  } finally { await close() }
})

test('buckets are independent per key', async () => {
  const { api, close } = await limited(1, 1)
  try {
    assert.equal((await api('/tasks', { key: 'k1' })).status, 200)
    assert.equal((await api('/tasks', { key: 'k1' })).status, 429)
    const other = await api('/tasks', { key: 'k2' })
    assert.equal(other.status, 200)
    assert.equal(other.headers.get('x-ratelimit-remaining'), '0')
  } finally { await close() }
})

test('401 requests do not touch any bucket', async () => {
  const { api, close } = await limited(1, 1)
  try {
    for (let i = 0; i < 5; i++) assert.equal((await api('/tasks', { key: 'bad' })).status, 401)
    for (let i = 0; i < 3; i++) assert.equal((await api('/tasks', { key: '' })).status, 401)
    const r = await api('/tasks')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-ratelimit-remaining'), '0')
  } finally { await close() }
})

test('every authenticated route and method costs a token', async () => {
  const { api, close } = await limited(3, 1)
  try {
    const c = await api('/tasks', { method: 'POST', body: { title: 'x' } })
    assert.equal(c.status, 201)
    assert.equal(c.headers.get('x-ratelimit-remaining'), '2')
    assert.equal((await api('/nope')).status, 404)
    assert.equal((await api(`/tasks/${c.body.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await api('/tasks')).status, 429)
  } finally { await close() }
})

test('invalid rateLimit config throws TypeError', () => {
  const bad = [
    { capacity: 0, refillPerSec: 1 }, { capacity: -1, refillPerSec: 1 }, { capacity: 1.5, refillPerSec: 1 },
    { capacity: '3', refillPerSec: 1 }, { capacity: 3, refillPerSec: 0 }, { capacity: 3, refillPerSec: -2 },
    { capacity: 3, refillPerSec: Infinity }, { capacity: 3, refillPerSec: NaN }, { capacity: 3, refillPerSec: '1' },
    { capacity: 3 }, { refillPerSec: 1 },
  ]
  for (const rateLimit of bad)
    assert.throws(() => createServer({ store: new TaskStore(), keys: ['k1'], rateLimit }), TypeError, JSON.stringify(rateLimit))
  assert.doesNotThrow(() => createServer({ store: new TaskStore(), keys: ['k1'], rateLimit: { capacity: 1, refillPerSec: 0.1 } }))
})

test('default clock works', async () => {
  const { api, close } = await start({ rateLimit: { capacity: 1, refillPerSec: 0.01 } })
  try {
    assert.equal((await api('/tasks')).status, 200)
    const r = await api('/tasks')
    assert.equal(r.status, 429)
    assert.ok(Number(r.headers.get('retry-after')) >= 99)
  } finally { await close() }
})

test('CRUD still works with rate limiting on', async () => {
  const { api, close } = await limited(100, 1)
  try {
    const c = (await api('/tasks', { method: 'POST', body: { title: 'x', tags: ['t'] } })).body
    assert.equal((await api(`/tasks/${c.id}`, { method: 'PATCH', body: { status: 'done' } })).body.status, 'done')
    assert.equal((await api('/tasks?tag=t')).body.items.length, 1)
  } finally { await close() }
})
