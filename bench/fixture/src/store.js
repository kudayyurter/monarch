// In-memory task store. Tasks are plain objects; callers get copies.
import { randomUUID } from 'node:crypto'

export const STATUSES = ['open', 'done']

export class TaskStore {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock
    this.tasks = new Map()
  }

  now() {
    return new Date(this.clock()).toISOString()
  }

  create({ title, due = null, tags = [] }) {
    const now = this.now()
    const task = { id: randomUUID(), title, due, tags: [...tags], status: 'open', createdAt: now, updatedAt: now }
    this.tasks.set(task.id, task)
    return { ...task, tags: [...task.tags] }
  }

  get(id) {
    const task = this.tasks.get(id)
    return task ? { ...task, tags: [...task.tags] } : null
  }

  update(id, patch) {
    const task = this.tasks.get(id)
    if (!task) return null
    Object.assign(task, patch, { updatedAt: this.now() })
    return { ...task, tags: [...task.tags] }
  }

  delete(id) {
    return this.tasks.delete(id)
  }

  // Filters: tag (exact match), status, dueBefore (YYYY-MM-DD, tasks due on or before that day).
  list({ page = 1, pageSize = 20, tag, status, dueBefore } = {}) {
    let items = [...this.tasks.values()]
    if (tag) items = items.filter(t => t.tags.includes(tag))
    if (status) items = items.filter(t => t.status === status)
    if (dueBefore) items = items.filter(t => t.due && t.due < dueBefore)
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const start = (page - 1) * pageSize
    return {
      items: items.slice(start, start + pageSize).map(t => ({ ...t, tags: [...t.tags] })),
      total: this.tasks.size,
      page,
      pageSize,
    }
  }
}
