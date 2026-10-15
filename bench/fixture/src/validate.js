// Request body validation. Each function returns an error message, or null when valid.
import { STATUSES } from './store.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/

function checkTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') return 'title must be a non-empty string'
  if (title.length > 200) return 'title must be at most 200 characters'
  return null
}

function checkDue(due) {
  if (due === null) return null
  if (typeof due !== 'string' || !DATE.test(due)) return 'due must be YYYY-MM-DD or null'
  return null
}

function checkTags(tags) {
  if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string' && t !== '')) return 'tags must be an array of non-empty strings'
  return null
}

export function validateNew(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object'
  return checkTitle(body.title)
    ?? ('due' in body ? checkDue(body.due) : null)
    ?? ('tags' in body ? checkTags(body.tags) : null)
}

export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object'
  if ('title' in body) { const e = checkTitle(body.title); if (e) return e }
  if ('due' in body) { const e = checkDue(body.due); if (e) return e }
  if ('tags' in body) { const e = checkTags(body.tags); if (e) return e }
  if ('status' in body && !STATUSES.includes(body.status)) return `status must be one of ${STATUSES.join(', ')}`
  return null
}
