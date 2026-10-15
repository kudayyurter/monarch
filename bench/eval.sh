#!/usr/bin/env bash
# Scores one finished arm: picks the branch that changed src/, runs its own tests and the hidden tests.
# Usage: bench/eval.sh <run-dir>   (a <out-root>/<task>-<arm> directory from run-arm.sh)
# Writes <run-dir>/{eval/, code.diff, score.json}.
set -uo pipefail
DIR="$(cd "$1" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK="$(basename "$DIR" | cut -d- -f1)"
cd "$DIR/repo"

BEST="" BEST_N=0
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  [ "$b" = main ] && continue
  n=$(git diff --numstat main..."$b" -- src/ | awk '{s += $1 + $2} END {print s + 0}')
  [ "$n" -gt "$BEST_N" ] && BEST="$b" BEST_N="$n"
done

rm -rf "$DIR/eval"
if [ -n "$BEST" ]; then
  git worktree add -q --detach "$DIR/eval" "$BEST"
  REF="main...$BEST"
  UNCOMMITTED=false
else
  # Nothing committed on a branch: score the main working tree as left by the run.
  cp -R "$DIR/repo" "$DIR/eval"
  REF=""
  UNCOMMITTED=true
fi

git diff $REF -- src/ test/ README.md package.json > "$DIR/code.diff"
STAT=$(git diff --shortstat $REF -- src/ test/ README.md package.json)
COMMITS=$( [ -n "$BEST" ] && git rev-list --count main.."$BEST" || echo 0)

cd "$DIR/eval"
OWN=$(npm test 2>&1)
OWN_PASS=$(printf '%s\n' "$OWN" | awk '/^ℹ pass/ {print $3}' | tail -1)
OWN_FAIL=$(printf '%s\n' "$OWN" | awk '/^ℹ fail/ {print $3}' | tail -1)

rm -rf hidden-test && cp -R "$HERE/hidden" hidden-test
HID=$(node --test "hidden-test/$TASK.test.js" 2>&1)
HID_PASS=$(printf '%s\n' "$HID" | awk '/^ℹ pass/ {print $3}' | tail -1)
HID_FAIL=$(printf '%s\n' "$HID" | awk '/^ℹ fail/ {print $3}' | tail -1)
FAILED=$(printf '%s\n' "$HID" | sed -n 's/^not ok [0-9]* - //p' | jq -R . | jq -s .)
rm -rf hidden-test

jq -n --arg branch "$BEST" --argjson uncommitted $UNCOMMITTED --argjson commits "${COMMITS:-0}" --arg stat "$STAT" \
  --argjson ownPass "${OWN_PASS:-0}" --argjson ownFail "${OWN_FAIL:-0}" \
  --argjson hiddenPass "${HID_PASS:-0}" --argjson hiddenFail "${HID_FAIL:-0}" --argjson hiddenFailed "$FAILED" \
  '{branch: $branch, uncommitted: $uncommitted, commits: $commits, diffStat: $stat, ownTests: {pass: $ownPass, fail: $ownFail}, hidden: {pass: $hiddenPass, fail: $hiddenFail, failed: $hiddenFailed}}' > "$DIR/score.json"
cat "$DIR/score.json"
