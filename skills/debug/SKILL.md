---
name: debug
description: Root-cause a bug or failing test before fixing it. Use for /monarch:debug <symptom>, "why is this failing", flaky or intermittent failures, or any bug whose cause is not obvious.
argument-hint: "<symptom or failing command>"
---

No fix before a cause. No cause before a red repro.

1. **Repro gate.** Get one command, already run, that fails on the exact reported symptom (a failing test, a script, a curl). Until you have it, form no hypotheses. If you cannot reproduce it, say so and list what you tried.
2. **Shrink.** Cut the repro down: fewer inputs, smaller data, one code path. Note what made the failure disappear.
3. **Hypotheses.** Write 3-5, ranked by likelihood. For each, write a prediction that would prove it wrong ("if X, then log Y shows Z").
4. **Test one at a time.** Add temporary logs tagged `[DEBUG-<4 chars>]`, or use a debugger. One hypothesis and one change per run. Record the result.
5. **Fix the cause**, not the symptom. Turn the repro into a regression test that fails before the fix and passes after. If there is no sensible place for a test, report that as a finding.
6. **Clean up.** `grep -rn "\[DEBUG-"` must return nothing. Re-run the repro and the related tests.

Stop rule: after 3 failed fix attempts, stop changing code. Report the repro, the hypotheses ruled out, and what the evidence points to, and ask how to proceed. Repeated failures usually mean a wrong assumption about the architecture, not a missing patch.

Report in at most 6 lines: symptom, root cause (file:line), fix, regression test, anything ruled out.
