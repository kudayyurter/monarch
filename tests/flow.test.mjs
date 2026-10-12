// Runs workflows/build.js end to end against scripted fake agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const body = readFileSync(join(root, 'workflows/build.js'), 'utf8').replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const script = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', body)

const ARGS = {
  brief: 'Goal: add modulo and power.', briefPath: '/wt/.monarch/brief.md', goal: 'add modulo and power',
  contextMap: { files: [{ path: 'src/calc.ts', why: 'ops' }] }, worktree: '/wt', base: 'main',
  branch: 'monarch/mod-pow', title: 'Add modulo and power', checks: { test: 'npm test', lint: null },
  codexScript: '/plugin/skills/codex-review/run.sh',
}

async function run(handlers) {
  const calls = []
  const counts = {}
  const agent = async (prompt, opts) => {
    const role = opts.agentType.replace('monarch:', '')
    counts[role] = (counts[role] || 0) + 1
    calls.push({ role, label: opts.label, prompt })
    const h = handlers[role]
    if (!h) throw new Error(`no handler for ${role}`)
    return h(prompt, counts[role], opts)
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const result = await script(agent, parallel, null, () => {}, () => {}, ARGS, { total: null }, null)
  return { result, calls, counts }
}

const finding = o => ({ severity: 'major', category: 'correctness', file: 'src/calc.ts', line: 20, endLine: 22, problem: 'pow ignores negative exponent', fix: 'handle b < 0', ...o })

const base = {
  planner: () => ({
    tasks: [
      { id: 'T1', title: 'Add mod', type: 'feat', files: ['src/mod.ts', 'test/mod.test.ts'], dependsOn: [], acceptance: ['mod(5,3) is 2'], tests: 'test/mod.test.ts' },
      { id: 'T2', title: 'Add pow', type: 'feat', files: ['src/pow.ts', 'test/pow.test.ts'], dependsOn: [], acceptance: ['pow(2,3) is 8'], tests: 'test/pow.test.ts' },
    ],
    assumptions: ['integers only'],
  }),
  builder: () => ({ status: 'done', files: [], summary: 'implemented', testsRun: 'npm test -- mod' }),
  'task-reviewer': (p, n) => (p.includes('T2') && !p.includes('FINAL') && n <= 2 && !globalThis.__t2passed
    ? (globalThis.__t2passed = true, { verdict: 'fail', findings: [finding({})] })
    : { verdict: 'pass', findings: [], commit: 'abc123' }),
  verifier: () => ({ pass: true, results: [{ check: 'test', ok: true }] }),
  shipper: (p) => ({ pushed: true, prUrl: 'https://github.com/x/y/pull/1' }),
  'pr-reviewer': (p, n) => (n === 1 ? { findings: [finding({ line: 21 }), finding({ file: 'src/mod.ts', line: 3, endLine: 3, severity: 'minor', category: 'quality' })] } : { findings: [] }),
  'codex-bridge': () => ({ ran: true, findings: [finding({ line: 22 }), finding({ file: 'src/pow.ts', line: 50, endLine: 50, category: 'security', problem: 'x' })] }),
  'finding-verifier': () => ({ real: false, reason: 'handled upstream' }),
  fixer: () => ({ fixed: ['pow negative'], summary: 'fixed', commit: 'def456' }),
}

test('happy path: builds, retries a failed task review, merges dual review, fixes, comments', async () => {
  globalThis.__t2passed = false
  const { result, calls, counts } = await run(base)
  assert.equal(result.ok, true)
  assert.equal(result.pr, 'https://github.com/x/y/pull/1')
  assert.deepEqual(result.tasks, { done: 2, total: 2, notDone: [] })
  assert.equal(counts.builder, 3, 'T2 rebuilt once after review failure')
  assert.equal(counts['finding-verifier'], 1, 'only the codex-only actionable finding is verified')
  assert.equal(result.review.droppedAsFalse, 1)
  assert.equal(result.review.fixed, 1)
  assert.deepEqual(result.review.open, [])
  assert.equal(result.review.minor, 1)
  assert.equal(result.draft, false)
  const rebuild = calls.find(c => c.label === 'build T2 r1')
  assert.match(rebuild.prompt, /pow ignores negative exponent/)
  const comment = calls.filter(c => c.role === 'shipper').pop().prompt
  assert.match(comment, /\[both\]/)
  assert.match(comment, /Codex review: ran/)
})

test('blocked task skips its dependents, PR goes draft when checks fail, codex skipped', async () => {
  const h = {
    ...base,
    planner: () => ({
      tasks: [
        { id: 'T1', title: 'Broken', type: 'feat', files: ['a.ts'], dependsOn: [], acceptance: ['x'], tests: 't' },
        { id: 'T2', title: 'Needs T1', type: 'feat', files: ['b.ts'], dependsOn: ['T1'], acceptance: ['y'], tests: 't' },
        { id: 'T3', title: 'Independent', type: 'feat', files: ['c.ts'], dependsOn: [], acceptance: ['z'], tests: 't' },
      ],
      assumptions: [],
    }),
    'task-reviewer': p => (p.includes('Task T1')
      ? { verdict: 'fail', findings: [finding({ file: 'a.ts' })], stash: p.includes('FINAL') ? 'monarch blocked T1' : undefined }
      : { verdict: 'pass', findings: [], commit: 'c1' }),
    verifier: () => ({ pass: false, results: [{ check: 'test', ok: false, output: 'FAIL x' }] }),
    'codex-bridge': () => ({ ran: false, skippedReason: 'codex not logged in', findings: [] }),
    'pr-reviewer': () => ({ findings: [] }),
  }
  const { result, counts, calls } = await run(h)
  assert.equal(result.ok, true)
  assert.equal(result.tasks.done, 1)
  assert.deepEqual(result.tasks.notDone.map(t => [t.id, t.status]), [['T1', 'blocked'], ['T2', 'skipped']])
  assert.equal(result.tasks.notDone[0].stash, 'monarch blocked T1')
  assert.equal(counts.builder, 4, 'T1 built 3 times, T3 once')
  assert.equal(result.draft, true)
  assert.match(result.review.codex, /skipped: codex not logged in/)
  const prCall = calls.find(c => c.label === 'push + PR')
  assert.match(prCall.prompt, /--draft/)
  assert.match(prCall.prompt, /\[monarch: checks failing\]/)
})

test('invalid plan is sent back once, then the run stops at plan stage', async () => {
  const h = { ...base, planner: () => ({ tasks: [{ id: 'T1', title: 'a', type: 'feat', files: [], dependsOn: ['T1'], acceptance: [], tests: '' }], assumptions: [] }) }
  const { result, counts } = await run(h)
  assert.equal(counts.planner, 2)
  assert.deepEqual(result, { ok: false, stage: 'plan', error: 'dependency cycle at T1' })
})

test('dead agent is retried once', async () => {
  let died = false
  const h = { ...base, verifier: () => (died ? { pass: true, results: [] } : (died = true, null)) }
  globalThis.__t2passed = true
  const { result, counts } = await run(h)
  assert.equal(result.ok, true)
  assert.ok(counts.verifier >= 2)
})
