Fix these three bugs reported against tasklite. Add regression tests for each.

1. "I list tasks with `GET /tasks?dueBefore=2026-10-15` and tasks due on 2026-10-15 are missing. The README says the filter keeps tasks due on or before that day."

2. "When I filter with `?tag=work` the response says `total: 57` but only 3 tasks have that tag. My pagination UI shows 3 pages of empty results." The `total` must be the number of tasks matching the filters.

3. "I sent `PATCH /tasks/<id>` with `{"id": "abc", "createdAt": "2000-01-01T00:00:00.000Z"}` and got 200. Now the task shows id `abc`, `GET /tasks/abc` returns 404, and the creation date is wrong." PATCH may only change `title`, `due`, `tags` and `status`. A body with any other field must be rejected with `400 {"error":"validation", ...}` and leave the task unchanged.
