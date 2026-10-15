// Shared helpers for hidden acceptance tests. Uses only the public contract.
import { TaskStore } from '../src/store.js'
import { createServer } from '../src/server.js'

export async function start(opts = {}) {
  const server = createServer({ store: new TaskStore(), keys: ['k1', 'k2'], ...opts })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (path, { method = 'GET', body, key = 'k1' } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined }
  }
  return { api, close: () => new Promise(r => server.close(r)) }
}

export function fakeClock(t = 1_000_000) {
  const clock = () => t
  clock.advance = ms => { t += ms }
  return clock
}
