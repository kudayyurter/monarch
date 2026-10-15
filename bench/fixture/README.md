# tasklite

In-memory task tracker with a JSON HTTP API. No dependencies; Node 20+.

```js
import { TaskStore } from './src/store.js'
import { createServer } from './src/server.js'

createServer({ store: new TaskStore(), keys: ['secret-key'] }).listen(3000)
```

Every request needs an `x-api-key` header with an accepted key, otherwise `401 {"error":"unauthorized"}`.

| Route | Description |
|---|---|
| `GET /tasks?page&pageSize&tag&status&dueBefore` | List tasks. `pageSize` max 100. `dueBefore=YYYY-MM-DD` keeps tasks due on or before that day. Response: `{items, total, page, pageSize}` where `total` is the number of tasks matching the filters. |
| `POST /tasks` | Create `{title, due?, tags?}`. Returns 201 with the task. |
| `GET /tasks/:id` | Get one task. |
| `PATCH /tasks/:id` | Update `title`, `due`, `tags` or `status` (`open` or `done`). |
| `DELETE /tasks/:id` | Delete. Returns 204. |

Validation errors return `400 {"error":"validation","message":...}`.

Tests: `npm test`.
