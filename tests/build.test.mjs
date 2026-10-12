// Unit tests for the pure helpers in workflows/build.js, plus schema sanity checks.
// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'workflows/build.js'), 'utf8')

const pure = src.slice(src.indexOf('// <pure>'), src.indexOf('// </pure>'))
const names = ['isActionable', 'maxSeverity', 'rangesOverlap', 'sameIssue', 'mergeFindings', 'validatePlan',
  'readyTasks', 'propagateSkips', 'contextSlice', 'findingLine', 'formatReviewComment']
const H = new Function(`${pure}\nreturn { ${names.join(', ')} }`)()

const f = (o) => ({ severity: 'major', category: 'correctness', file: 'a.ts', line: 10, endLine: 12, problem: 'p', fix: 'x', ...o })

test('meta is a pure literal with required fields', () => {
  const m = src.match(/export const meta = (\{[\s\S]*?\n\})/)
  assert.ok(m, 'meta block found')
  const meta = new Function(`return ${m[1]}`)()
  assert.equal(meta.name, 'build')
  assert.ok(meta.description)
  const phaseCalls = [...src.matchAll(/phase\('([^']+)'\)/g)].map(x => x[1])
  for (const p of phaseCalls) assert.ok(meta.phases.some(ph => ph.title === p), `phase ${p} declared in meta`)
})

test('script avoids APIs that break workflow resume', () => {
  assert.doesNotMatch(src, /Date\.now\(\)|Math\.random\(\)|new Date\(\)/)
})

test('mergeFindings pairs overlapping same-category findings as both', () => {
  const out = H.mergeFindings([f({})], [f({ line: 13, endLine: 13, severity: 'blocking' })])
  assert.equal(out.length, 1)
  assert.equal(out[0].source, 'both')
  assert.equal(out[0].severity, 'blocking')
})

test('mergeFindings keeps distant or different-category findings separate', () => {
  const out = H.mergeFindings([f({})], [f({ line: 40, endLine: 41 }), f({ category: 'security' })])
  assert.deepEqual(out.map(x => x.source), ['claude', 'codex', 'codex'])
})

test('mergeFindings matches each codex finding at most once', () => {
  const out = H.mergeFindings([f({}), f({ line: 11 })], [f({})])
  assert.deepEqual(out.map(x => x.source), ['both', 'claude'])
})

test('mergeFindings handles empty inputs', () => {
  assert.deepEqual(H.mergeFindings([], []), [])
  assert.equal(H.mergeFindings([], [f({})])[0].source, 'codex')
})

test('rangesOverlap uses slack and missing endLine', () => {
  assert.ok(H.rangesOverlap({ line: 10 }, { line: 13 }, 3))
  assert.ok(!H.rangesOverlap({ line: 10 }, { line: 14 }, 3))
})

test('validatePlan catches bad plans', () => {
  assert.equal(H.validatePlan([]), 'planner returned no tasks')
  assert.match(H.validatePlan([{ id: 'T1' }, { id: 'T1' }]), /duplicate/)
  assert.match(H.validatePlan([{ id: 'T1', dependsOn: ['T9'] }]), /unknown/)
  assert.match(H.validatePlan([{ id: 'T1', dependsOn: ['T2'] }, { id: 'T2', dependsOn: ['T1'] }]), /cycle/)
  assert.equal(H.validatePlan([{ id: 'T1' }, { id: 'T2', dependsOn: ['T1'] }]), null)
})

const tasks = [
  { id: 'T1', files: ['a.ts'] },
  { id: 'T2', files: ['b.ts'] },
  { id: 'T3', files: ['a.ts'], dependsOn: ['T1'] },
  { id: 'T4', files: ['package.json'], exclusive: true },
  { id: 'T5', files: ['b.ts'] },
]

test('readyTasks respects deps, file overlap and exclusivity', () => {
  const st = { T1: 'pending', T2: 'pending', T3: 'pending', T4: 'pending', T5: 'pending' }
  assert.deepEqual(H.readyTasks(tasks, st, []).map(t => t.id), ['T1', 'T2'])
  const st2 = { T1: 'running', T2: 'done', T3: 'pending', T4: 'pending', T5: 'pending' }
  assert.deepEqual(H.readyTasks(tasks, st2, ['T1']).map(t => t.id), ['T5'])
  const st3 = { T1: 'done', T2: 'done', T3: 'done', T4: 'pending', T5: 'done' }
  assert.deepEqual(H.readyTasks(tasks, st3, []).map(t => t.id), ['T4'])
  const st4 = { T1: 'done', T2: 'done', T3: 'done', T4: 'running', T5: 'pending' }
  assert.deepEqual(H.readyTasks(tasks, st4, ['T4']), [])
})

test('exclusive task does not start beside others', () => {
  const st = { T4: 'pending', T2: 'pending' }
  const ts = [tasks[3], tasks[1]]
  assert.deepEqual(H.readyTasks(ts, st, []).map(t => t.id), ['T4'])
  assert.deepEqual(H.readyTasks([tasks[1], tasks[3]], st, []).map(t => t.id), ['T2'])
})

test('propagateSkips cascades through dependents', () => {
  const ts = [{ id: 'T1' }, { id: 'T2', dependsOn: ['T1'] }, { id: 'T3', dependsOn: ['T2'] }, { id: 'T4' }]
  const st = H.propagateSkips(ts, { T1: 'blocked', T2: 'pending', T3: 'pending', T4: 'pending' })
  assert.deepEqual(st, { T1: 'blocked', T2: 'skipped', T3: 'skipped', T4: 'pending' })
})

test('contextSlice gives own files plus shared ones', () => {
  const map = { files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'shared/util.ts' }] }
  assert.deepEqual(H.contextSlice(map, tasks[0], tasks).map(x => x.path), ['a.ts', 'shared/util.ts'])
  assert.deepEqual(H.contextSlice(undefined, tasks[0], tasks), [])
})

test('formatReviewComment tags sources and handles empty', () => {
  assert.match(H.formatReviewComment([], 'Codex review: ran.'), /No open findings/)
  const c = H.formatReviewComment([{ ...f({}), source: 'both', status: 'fixed' }], 'x')
  assert.match(c, /\[both\] \*\*major\*\* `a\.ts:10`/)
  assert.match(c, /fixed/)
})

test('codex findings schema is strict and consistent', () => {
  const s = JSON.parse(readFileSync(join(root, 'skills/codex-review/findings.schema.json'), 'utf8'))
  const item = s.properties.findings.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort())
})

test('every agent referenced by the workflow exists with frontmatter model', () => {
  const roles = [...new Set([...src.matchAll(/call\('([a-z-]+)'/g)].map(x => x[1]))]
  for (const r of roles) {
    const md = readFileSync(join(root, 'agents', `${r}.md`), 'utf8')
    assert.match(md, new RegExp(`^---\\nname: ${r}\\n`), `${r} frontmatter name`)
    assert.match(md, /\nmodel: (opus|sonnet)\n/, `${r} model`)
    assert.ok(md.split(/\s+/).length <= 520, `${r} under ~500 words`)
  }
})

test('whole script parses as an async workflow body', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const body = src.replace('export const meta', 'const meta')
  assert.doesNotThrow(() => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', body))
})
