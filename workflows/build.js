export const meta = {
  name: 'build',
  description: 'monarch: plan an approved brief, build each task with its own reviewed subagent, verify, open a PR, and run a dual Claude + Codex final review',
  whenToUse: 'Launched by /monarch after the user approves the brief. Needs args {brief, briefPath, contextMap, worktree, base, branch, title, checks, codexScript}.',
  phases: [
    { title: 'Plan', detail: 'planner splits the brief into tasks' },
    { title: 'Build', detail: 'one builder + one reviewer per task, max 2 fix rounds' },
    { title: 'Verify', detail: 'full checks, max 2 fixer rounds' },
    { title: 'Ship', detail: 'push and open PR' },
    { title: 'Review', detail: 'Claude pr-reviewer + Codex in parallel, merge, verify, fix' },
  ],
}

// <pure> — dependency-free helpers, unit tested by tests/build.test.mjs
const MAX_FIX_ROUNDS = 2
const SEVERITY_RANK = { minor: 0, major: 1, blocking: 2 }

// Blocking and major findings always get fixed. Correctness and security findings get fixed at any
// severity, except "cannot verify" notes, which stay informational.
const ALWAYS_FIX = new Set(['correctness', 'security'])

function isActionable(f) {
  if (!f) return false
  if (f.severity === 'blocking' || f.severity === 'major') return true
  return ALWAYS_FIX.has(f.category) && !/^cannot verify/i.test(f.problem || '')
}

function maxSeverity(a, b) {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

function rangesOverlap(a, b, slack) {
  const aStart = a.line ?? 0, aEnd = a.endLine ?? aStart
  const bStart = b.line ?? 0, bEnd = b.endLine ?? bStart
  return aStart <= bEnd + slack && bStart <= aEnd + slack
}

function sameIssue(a, b) {
  return a.file === b.file && a.category === b.category && rangesOverlap(a, b, 3)
}

// Pair Claude and Codex findings. Matches become source 'both'; the rest keep their single source.
function mergeFindings(claude, codex) {
  const used = new Set()
  const out = []
  for (const c of claude) {
    const j = codex.findIndex((x, i) => !used.has(i) && sameIssue(c, x))
    if (j >= 0) {
      used.add(j)
      out.push({ ...c, severity: maxSeverity(c.severity, codex[j].severity), source: 'both', codexProblem: codex[j].problem })
    } else {
      out.push({ ...c, source: 'claude' })
    }
  }
  codex.forEach((x, i) => { if (!used.has(i)) out.push({ ...x, source: 'codex' }) })
  return out
}

// Validate planner output: unique ids, known dependencies, no cycles. Returns an error string or null.
function validatePlan(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return 'planner returned no tasks'
  const ids = new Set()
  for (const t of tasks) {
    if (ids.has(t.id)) return `duplicate task id ${t.id}`
    ids.add(t.id)
  }
  for (const t of tasks) {
    for (const d of t.dependsOn || []) if (!ids.has(d)) return `${t.id} depends on unknown ${d}`
  }
  const state = {}
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]))
  const visit = id => {
    if (state[id] === 'done') return null
    if (state[id] === 'active') return `dependency cycle at ${id}`
    state[id] = 'active'
    for (const d of byId[id].dependsOn || []) { const e = visit(d); if (e) return e }
    state[id] = 'done'
    return null
  }
  for (const t of tasks) { const e = visit(t.id); if (e) return e }
  return null
}

// Fold the planner's edge cases into the owning task's acceptance checks, so builder and reviewer both see them.
function withEdgeCases(tasks, edgeCases) {
  return tasks.map(t => {
    const extra = (edgeCases || []).filter(e => e.task === t.id).map(e => `Edge case: ${e.case}. Expected: ${e.expected}`)
    return extra.length ? { ...t, acceptance: [...(t.acceptance || []), ...extra] } : t
  })
}

// Tasks that may start now: pending, all deps done, no file overlap with running tasks,
// and exclusive tasks only when nothing else runs (and nothing else starts beside them).
function readyTasks(tasks, status, runningIds) {
  const running = tasks.filter(t => runningIds.includes(t.id))
  if (running.some(t => t.exclusive)) return []
  const busy = new Set(running.flatMap(t => t.files || []))
  const ready = []
  for (const t of tasks) {
    if (status[t.id] !== 'pending') continue
    if (!(t.dependsOn || []).every(d => status[d] === 'done')) continue
    if ((t.files || []).some(f => busy.has(f))) continue
    if (t.exclusive) {
      if (running.length === 0 && ready.length === 0) return [t]
      continue
    }
    ready.push(t)
    for (const f of t.files || []) busy.add(f)
  }
  return ready
}

// Mark pending tasks whose dependency was blocked or skipped. Mutates and returns status.
function propagateSkips(tasks, status) {
  let changed = true
  while (changed) {
    changed = false
    for (const t of tasks) {
      if (status[t.id] !== 'pending') continue
      if ((t.dependsOn || []).some(d => status[d] === 'blocked' || status[d] === 'skipped')) {
        status[t.id] = 'skipped'
        changed = true
      }
    }
  }
  return status
}

function contextSlice(contextMap, task, allTasks) {
  const files = (contextMap && contextMap.files) || []
  const owned = new Set(allTasks.flatMap(t => t.files || []))
  const mine = new Set(task.files || [])
  return files.filter(f => mine.has(f.path) || !owned.has(f.path))
}

function findingLine(f) {
  const where = f.line ? `${f.file}:${f.line}${f.endLine && f.endLine !== f.line ? '-' + f.endLine : ''}` : f.file
  return `- [${f.severity}] ${where} — ${f.problem} Fix: ${f.fix}`
}

function formatReviewComment(findings, codexStatus) {
  const tag = f => (f.source ? `[${f.source}] ` : '')
  const lines = ['## monarch review', '']
  lines.push(codexStatus)
  lines.push('')
  if (findings.length === 0) {
    lines.push('No open findings.')
  } else {
    for (const f of findings) lines.push(`- ${tag(f)}**${f.severity}** \`${f.file}:${f.line}\` (${f.category}): ${f.problem} _Fix:_ ${f.fix}${f.status ? ` — ${f.status}` : ''}`)
  }
  return lines.join('\n')
}
// </pure>

const A = args || {}
const WT = A.worktree
const BASE = A.base || 'main'
const CHECKS = A.checks || {}

const FINDING = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
    category: { type: 'string', enum: ['correctness', 'security', 'spec-gap', 'integration', 'tests', 'quality'] },
    file: { type: 'string' },
    line: { type: 'integer' },
    endLine: { type: 'integer' },
    problem: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['severity', 'file', 'problem', 'fix'],
}
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: FINDING } }, required: ['findings'] }

const PLAN = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          type: { type: 'string', enum: ['feat', 'fix', 'refactor', 'test', 'chore'] },
          files: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          interface: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          tests: { type: 'string' },
          exclusive: { type: 'boolean' },
        },
        required: ['id', 'title', 'type', 'files', 'dependsOn', 'acceptance', 'tests'],
      },
    },
    constraints: { type: 'array', items: { type: 'string' } },
    reviewFocus: { type: 'array', items: { type: 'string' } },
    edgeCases: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'string' }, case: { type: 'string' }, expected: { type: 'string' } },
        required: ['task', 'case', 'expected'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['tasks', 'constraints', 'reviewFocus', 'edgeCases', 'assumptions'],
}
const BUILD = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    files: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['status', 'files', 'summary'],
}
const TASK_REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: { type: 'array', items: FINDING },
    commit: { type: 'string' },
    stash: { type: 'string' },
  },
  required: ['verdict', 'findings'],
}
const VERIFY = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    results: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, ok: { type: 'boolean' }, output: { type: 'string' } }, required: ['check', 'ok'] } },
  },
  required: ['pass', 'results'],
}
const FIX = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
    commit: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['fixed', 'summary'],
}
const SHIP = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean' },
    prUrl: { type: 'string' },
    commentUrl: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['pushed'],
}
const CODEX = {
  type: 'object',
  properties: {
    ran: { type: 'boolean' },
    skippedReason: { type: 'string' },
    findings: { type: 'array', items: FINDING },
  },
  required: ['ran', 'findings'],
}
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }

const EFFORT = {
  scout: 'low', planner: 'medium', builder: 'medium', 'task-reviewer': 'medium', verifier: 'low',
  fixer: 'medium', shipper: 'low', 'pr-reviewer': 'high', 'finding-verifier': 'high', 'codex-bridge': 'low',
}

// One retry when an agent dies; null after that.
async function call(role, prompt, schema, label, phaseName) {
  const opts = { agentType: `monarch:${role}`, schema, effort: EFFORT[role], label, phase: phaseName }
  const first = await agent(prompt, opts)
  if (first) return first
  log(`${label}: agent returned nothing, retrying once`)
  return agent(prompt, { ...opts, label: `${label} (retry)` })
}

const header = `Worktree: ${WT}\nBranch: ${A.branch} (base ${BASE})\n`
const checkList = Object.entries(CHECKS).filter(([, cmd]) => cmd).map(([k, cmd]) => `${k}: ${cmd}`).join('\n') || '(no checks configured)'

// ---------- Plan ----------
phase('Plan')
if (!WT || !A.brief) throw new Error('monarch:build needs args.worktree and args.brief')

let plan = await call('planner',
  `${header}\nBrief:\n${A.brief}\n\nContext map:\n${JSON.stringify(A.contextMap || {}, null, 1)}\n\nCheck commands:\n${checkList}`,
  PLAN, 'plan', 'Plan')
let planError = plan ? validatePlan(plan.tasks) : 'planner died'
if (planError && plan) {
  log(`plan invalid (${planError}), asking planner to fix it`)
  plan = await call('planner',
    `${header}\nYour previous plan was invalid: ${planError}\nReturn a corrected plan.\n\nBrief:\n${A.brief}\n\nPrevious plan:\n${JSON.stringify(plan)}`,
    PLAN, 'plan (fix)', 'Plan')
  planError = plan ? validatePlan(plan.tasks) : 'planner died'
}
if (planError) return { ok: false, stage: 'plan', error: planError }

const edgeCases = plan.edgeCases || []
const tasks = withEdgeCases(plan.tasks, edgeCases)
const assumptions = plan.assumptions || []
const constraints = plan.constraints || []
const reviewFocus = plan.reviewFocus || []
const constraintText = constraints.length ? `Constraints (exact):\n${constraints.map(c => `- ${c}`).join('\n')}` : ''
log(`${tasks.length} task(s): ${tasks.map(t => `${t.id} ${t.title}`).join('; ')}`)

// ---------- Build ----------
phase('Build')
const status = Object.fromEntries(tasks.map(t => [t.id, 'pending']))
const results = {}

function builderPrompt(t, findings, round) {
  const deps = (t.dependsOn || []).map(d => {
    const dt = tasks.find(x => x.id === d)
    return `- ${d} ${dt.title}\n  interface: ${dt.interface || '(none)'}\n  built: ${results[d]?.summary || ''}`
  }).join('\n')
  return [
    header,
    `Feature goal (from the brief): ${A.goal || A.title || ''}`,
    `Your task ${t.id}: ${t.title} (${t.type})`,
    `Files you may edit: ${t.files.join(', ')}`,
    t.interface ? `Interface to provide exactly: ${t.interface}` : '',
    `Acceptance checks:\n${t.acceptance.map(a => `- ${a}`).join('\n')}`,
    constraintText,
    `Tests: ${t.tests}`,
    deps ? `Done tasks you build on:\n${deps}` : '',
    `Context:\n${JSON.stringify(contextSlice(A.contextMap, t, tasks), null, 1)}`,
    `Targeted test command base: ${CHECKS.test || '(none)'}`,
    round > 0 ? `Review round ${round}. Fix these findings:\n${findings.map(findingLine).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

function reviewPrompt(t, files, built, finalRound) {
  return [
    header,
    `Task ${t.id}: ${t.title} (${t.type})`,
    `Task files: ${files.join(', ')}`,
    `Acceptance checks:\n${t.acceptance.map(a => `- ${a}`).join('\n')}`,
    constraintText,
    `Tests expected: ${t.tests}`,
    `Builder says: ${built.summary}\nTests run: ${built.testsRun || '(not reported)'}`,
    finalRound ? 'FINAL ROUND: if the verdict is fail, stash the task files as instructed.' : '',
  ].filter(Boolean).join('\n\n')
}

async function runTask(t) {
  let findings = []
  let minor = []
  for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
    const tag = round ? ` r${round}` : ''
    const built = await call('builder', builderPrompt(t, findings, round), BUILD, `build ${t.id}${tag}`, 'Build')
    if (!built) return { status: 'blocked', reason: 'builder died' }
    const files = [...new Set([...(t.files || []), ...(built.files || [])])]
    const finalRound = round === MAX_FIX_ROUNDS
    const review = await call('task-reviewer', reviewPrompt(t, files, built, finalRound), TASK_REVIEW, `review ${t.id}${tag}`, 'Build')
    if (!review) return { status: 'blocked', reason: 'reviewer died' }
    if (review.verdict === 'pass') {
      minor = review.findings.filter(f => !isActionable(f))
      return { status: 'done', commit: review.commit, summary: built.summary, minor }
    }
    findings = review.findings.filter(isActionable)
    if (findings.length === 0) findings = review.findings
    if (finalRound) {
      return { status: 'blocked', reason: findings.map(f => f.problem).join(' | '), stash: review.stash, findings }
    }
  }
  return { status: 'blocked', reason: 'fix rounds exhausted' }
}

const running = new Map()
while (true) {
  propagateSkips(tasks, status)
  for (const t of readyTasks(tasks, status, [...running.keys()])) {
    status[t.id] = 'running'
    running.set(t.id, runTask(t).then(r => {
      results[t.id] = r
      status[t.id] = r.status
      running.delete(t.id)
      log(`${t.id} ${r.status}${r.reason ? `: ${r.reason}` : ''}`)
    }))
  }
  if (running.size === 0) break
  await Promise.race(running.values())
}

const done = tasks.filter(t => status[t.id] === 'done')
const notDone = tasks.filter(t => status[t.id] !== 'done').map(t => ({
  id: t.id, title: t.title, status: status[t.id], reason: results[t.id]?.reason || 'dependency not done', stash: results[t.id]?.stash,
}))
const taskReport = { done: done.length, total: tasks.length, notDone }

if (done.length === 0) {
  return { ok: false, stage: 'build', tasks: taskReport, assumptions }
}

// ---------- Verify ----------
async function verifyLoop(phaseName) {
  let v = null
  for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
    v = await call('verifier', `${header}\nRun these checks from the worktree root:\n${checkList}`, VERIFY, `verify${round ? ` r${round}` : ''}`, phaseName)
    if (!v || v.pass || round === MAX_FIX_ROUNDS) break
    const failures = v.results.filter(r => !r.ok).map(r => `- ${r.check}:\n${r.output || ''}`).join('\n')
    await call('fixer', `${header}\nFix these failing checks:\n${failures}\n\nCheck commands:\n${checkList}`, FIX, `fix checks r${round + 1}`, phaseName)
  }
  return v
}

phase('Verify')
let checks = await verifyLoop('Verify')
const checksPass = !!(checks && checks.pass)

// ---------- Ship ----------
phase('Ship')
const prBody = [
  `## Brief\n\n${A.brief}`,
  `## Tasks\n\n${tasks.map(t => `- [${status[t.id] === 'done' ? 'x' : ' '}] ${t.id} ${t.title}${status[t.id] !== 'done' ? ` (${status[t.id]})` : ''}`).join('\n')}`,
  assumptions.length ? `## Assumptions\n\n${assumptions.map(a => `- ${a}`).join('\n')}` : '',
  `## Checks\n\n${checksPass ? 'All checks pass.' : 'Checks failing — see review comment.'}`,
  '_Built by monarch._',
].filter(Boolean).join('\n\n')
const prTitle = `${checksPass ? '' : '[monarch: checks failing] '}${A.title || A.branch}`

let ship = await call('shipper',
  `${header}\nOperations:\n1. Push the branch.\n2. Create the PR${checksPass ? '' : ' as --draft'} with title: ${prTitle}\n\nPR body:\n${prBody}`,
  SHIP, 'push + PR', 'Ship')
const prUrl = ship?.prUrl || ''

// ---------- Review ----------
phase('Review')
const reviewContext = [
  `${header}\nBrief file: ${A.briefPath}\n\nBrief:\n${A.brief}`,
  constraintText,
  reviewFocus.length ? `Review focus:\n${reviewFocus.map(r => `- ${r}`).join('\n')}` : '',
  edgeCases.length ? `Edge cases the plan committed to (each must be handled and tested):\n${edgeCases.map(e => `- ${e.task}: ${e.case}. Expected: ${e.expected}`).join('\n')}` : '',
  `Tasks:\n${tasks.map(t => `- ${t.id} ${t.title} [${status[t.id]}]`).join('\n')}`,
].filter(Boolean).join('\n\n')
const [claudeReview, codexReview] = await parallel([
  () => call('pr-reviewer', `${reviewContext}\n\nReview git diff ${BASE}...HEAD.`, FINDINGS, 'pr-review claude', 'Review'),
  () => call('codex-bridge', `${header}\nScript: ${A.codexScript}\nBase: ${BASE}\nBrief file: ${A.briefPath}`, CODEX, 'pr-review codex', 'Review'),
])
const codexRan = !!(codexReview && codexReview.ran)
const codexStatus = codexRan
  ? `Codex review: ran (${codexReview.findings.length} raw findings).`
  : `Codex review skipped: ${codexReview?.skippedReason || 'bridge agent failed'}.`
log(codexStatus)

const merged = mergeFindings(claudeReview?.findings || [], codexRan ? codexReview.findings : [])
const toVerify = merged.filter(f => f.source !== 'both' && isActionable(f))
const verdicts = await parallel(toVerify.map(f => () =>
  call('finding-verifier', `${header}\nFinding (reported by ${f.source} only):\n${findingLine(f)}\nCategory: ${f.category || 'unknown'}`, VERDICT, `verify ${f.file}:${f.line || ''}`, 'Review')))
const dropped = []
const confirmed = merged.filter(f => {
  if (f.source === 'both' || !isActionable(f)) return true
  const v = verdicts[toVerify.indexOf(f)]
  if (v && !v.real) { dropped.push({ ...f, reason: v.reason }); return false }
  return true
})
log(`review: ${merged.length} merged, ${dropped.length} dropped by verification, ${confirmed.filter(isActionable).length} to fix`)

let open = confirmed.filter(isActionable)
const fixedFindings = []
for (let round = 1; round <= MAX_FIX_ROUNDS && open.length > 0; round++) {
  const fix = await call('fixer', `${header}\nFix these review findings:\n${open.map(findingLine).join('\n')}\n\nCheck commands:\n${checkList}`, FIX, `fix review r${round}`, 'Review')
  checks = await verifyLoop('Review')
  const recheck = await call('pr-reviewer',
    `${reviewContext}\n\nRe-check only. These findings were just addressed (fixer said: ${fix?.summary || 'n/a'}).\nReturn findings that are still unresolved, plus any blocking/major or correctness/security problem the fix introduced. Empty list if all resolved.\n${open.map(findingLine).join('\n')}`,
    FINDINGS, `recheck r${round}`, 'Review')
  const still = (recheck?.findings || []).filter(isActionable)
  for (const f of open) if (!still.some(s => s.file === f.file && rangesOverlap(s, f, 3))) fixedFindings.push({ ...f, status: 'fixed' })
  open = still.map(f => ({ ...f, source: f.source || 'claude' }))
}

const finalChecksPass = !!(checks && checks.pass)
const minorFindings = confirmed.filter(f => !isActionable(f))
const commentFindings = [...fixedFindings, ...open.map(f => ({ ...f, status: 'open' })), ...minorFindings]
const comment = formatReviewComment(commentFindings, codexStatus)

const finalOps = [
  '1. Push the branch (new fix commits may exist).',
  prUrl ? `2. Post this comment on ${prUrl}.` : '2. No PR exists; skip commenting.',
  prUrl && !checksPass && finalChecksPass ? `3. Checks now pass: run \`gh pr ready ${prUrl}\` and \`gh pr edit ${prUrl} --title "${A.title || A.branch}"\`.` : '',
  prUrl && checksPass && !finalChecksPass ? `3. Review fixes broke checks: run \`gh pr ready --undo ${prUrl}\` and \`gh pr edit ${prUrl} --title "[monarch: checks failing] ${A.title || A.branch}"\`.` : '',
].filter(Boolean).join('\n')
const finalShip = await call('shipper', `${header}\nOperations:\n${finalOps}\n\nComment body:\n${comment}`, SHIP, 'push + comment', 'Review')

return {
  ok: true,
  pr: prUrl || null,
  pushed: !!(ship?.pushed && finalShip?.pushed),
  shipError: ship?.error || finalShip?.error || null,
  draft: !!prUrl && !finalChecksPass,
  branch: A.branch,
  tasks: taskReport,
  checks: { pass: finalChecksPass, results: (checks?.results || []).map(r => ({ check: r.check, ok: r.ok })) },
  review: {
    codex: codexStatus,
    fixed: fixedFindings.length,
    open: open.map(f => ({ severity: f.severity, where: `${f.file}:${f.line || ''}`, problem: f.problem, source: f.source })),
    minor: minorFindings.length,
    droppedAsFalse: dropped.length,
  },
  assumptions,
}
