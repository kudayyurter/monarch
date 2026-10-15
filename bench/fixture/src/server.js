// JSON HTTP API over a TaskStore. Every request needs a valid x-api-key header.
import http from 'node:http'
import { validateNew, validatePatch } from './validate.js'

const MAX_BODY = 64 * 1024

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(data)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function parsePositiveInt(value, fallback, max) {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return NaN
  const n = Number(value)
  return n >= 1 && n <= max ? n : NaN
}

// options: { store, keys: iterable of accepted API keys }
export function createServer({ store, keys }) {
  const accepted = new Set(keys)

  return http.createServer(async (req, res) => {
    try {
      const key = req.headers['x-api-key']
      if (!key || !accepted.has(key)) return send(res, 401, { error: 'unauthorized' })

      const url = new URL(req.url, 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'tasks' || parts.length > 2) return send(res, 404, { error: 'not_found' })
      const id = parts[1]

      if (!id && req.method === 'GET') {
        const q = url.searchParams
        const page = parsePositiveInt(q.get('page'), 1, 1e6)
        const pageSize = parsePositiveInt(q.get('pageSize'), 20, 100)
        if (Number.isNaN(page) || Number.isNaN(pageSize)) return send(res, 400, { error: 'validation', message: 'page and pageSize must be positive integers (pageSize <= 100)' })
        const dueBefore = q.get('dueBefore') ?? undefined
        if (dueBefore !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dueBefore)) return send(res, 400, { error: 'validation', message: 'dueBefore must be YYYY-MM-DD' })
        return send(res, 200, store.list({ page, pageSize, tag: q.get('tag') ?? undefined, status: q.get('status') ?? undefined, dueBefore }))
      }

      if (!id && req.method === 'POST') {
        const body = await readJson(req)
        const err = validateNew(body)
        if (err) return send(res, 400, { error: 'validation', message: err })
        return send(res, 201, store.create(body))
      }

      if (id && req.method === 'GET') {
        const task = store.get(id)
        return task ? send(res, 200, task) : send(res, 404, { error: 'not_found' })
      }

      if (id && req.method === 'PATCH') {
        const body = await readJson(req)
        const err = validatePatch(body)
        if (err) return send(res, 400, { error: 'validation', message: err })
        const task = store.update(id, body)
        return task ? send(res, 200, task) : send(res, 404, { error: 'not_found' })
      }

      if (id && req.method === 'DELETE') {
        return store.delete(id) ? send(res, 204) : send(res, 404, { error: 'not_found' })
      }

      return send(res, 405, { error: 'method_not_allowed' })
    } catch (e) {
      if (e.status) return send(res, e.status, { error: e.status === 413 ? 'too_large' : 'validation', message: e.message })
      return send(res, 500, { error: 'internal' })
    }
  })
}
