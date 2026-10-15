#!/usr/bin/env bash
# Runs one benchmark arm headless on a fresh copy of the fixture.
# Usage: bench/run-arm.sh <task: ratelimit|bugfix> <arm: monarch|superpowers|plain> <out-root>
# Writes <out-root>/<task>-<arm>/{repo/, turn-N.json, meta.json}.
set -uo pipefail
TASK="$1" ARM="$2" OUT="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$OUT/$TASK-$ARM"
rm -rf "$DIR" && mkdir -p "$DIR"
cp -R "$HERE/fixture" "$DIR/repo"
cd "$DIR/repo"
git init -q -b main && git add -A && git -c user.name=bench -c user.email=bench@example.com commit -qm "chore: initial tasklite"

# Only the arm's own plugin is enabled; MCP servers are off for every arm.
OFF='"superpowers@claude-plugins-official":false,"caveman@caveman":false,"vercel@claude-plugins-official":false,"aws-core@claude-plugins-official":false,"deploy-on-aws@claude-plugins-official":false,"aws-serverless@claude-plugins-official":false,"neon@claude-plugins-official":false,"github@claude-plugins-official":false,"commit-commands@claude-plugins-official":false,"andrej-karpathy-skills@karpathy-skills":false,"monarch@monarch-local":false'
case "$ARM" in
  monarch)     SETTINGS="{\"enabledPlugins\":{$OFF,\"monarch@monarch-local\":true}}" ;;
  superpowers) SETTINGS="{\"enabledPlugins\":{$OFF,\"superpowers@claude-plugins-official\":true}}" ;;
  plain)       SETTINGS="{\"enabledPlugins\":{$OFF}}" ;;
  *) echo "unknown arm $ARM" >&2; exit 64 ;;
esac

REQ="$(cat "$HERE/tasks/$TASK.md")

Work autonomously: do not ask me questions; make reasonable decisions and note them. When you are finished, the work must be committed on a feature branch (not main)."
case "$ARM" in
  monarch)     PROMPT="/monarch:monarch $REQ" ;;
  superpowers) PROMPT="Use the superpowers workflow for this: brainstorming, then writing-plans, then subagent-driven-development.

$REQ" ;;
  plain)       PROMPT="$REQ" ;;
esac
CONTINUE="Approved. Proceed through every remaining step autonomously without asking me anything. Whenever there is a choice, pick the recommended option."

COMMON=(--model opus --settings "$SETTINGS" --strict-mcp-config --dangerously-skip-permissions --output-format json)

# A branch other than main that changes src/ means the work landed.
landed() {
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
    [ "$b" = main ] && continue
    [ -n "$(git diff --name-only main..."$b" -- src/ 2>/dev/null)" ] && return 0
  done
  return 1
}

START=$(date +%s)
claude -p "$PROMPT" "${COMMON[@]}" > "$DIR/turn-1.json" 2> "$DIR/turn-1.err"
SESSION=$(jq -r '.[-1].session_id // .session_id' "$DIR/turn-1.json" 2>/dev/null)
N=1
while [ $N -lt 5 ]; do
  LAST=$(jq -r '.[-1].result // .result // ""' "$DIR/turn-$N.json" 2>/dev/null)
  if landed && ! printf '%s' "$LAST" | tail -c 400 | grep -qiE '\?\s*$|approve|would you like|which (option|approach)|shall i|should i'; then break; fi
  N=$((N + 1))
  claude -p "$CONTINUE" --resume "$SESSION" "${COMMON[@]}" > "$DIR/turn-$N.json" 2> "$DIR/turn-$N.err"
done
END=$(date +%s)

jq -s --arg arm "$ARM" --arg task "$TASK" --argjson secs $((END - START)) --argjson turns $N '
  map(if type == "array" then .[-1] else . end) |
  { arm: $arm, task: $task, wallSeconds: $secs, userTurns: $turns,
    costUsd: (map(.total_cost_usd // 0) | add),
    outputTokens: (map(.modelUsage // {} | to_entries | map(.value.outputTokens // 0) | add // 0) | add),
    inputTokens: (map(.modelUsage // {} | to_entries | map((.value.inputTokens // 0) + (.value.cacheReadInputTokens // 0) + (.value.cacheCreationInputTokens // 0)) | add // 0) | add),
    byModel: (map(.modelUsage // {} | to_entries) | flatten | group_by(.key) | map({ key: .[0].key, value: { out: (map(.value.outputTokens // 0) | add), costUsd: (map(.value.costUSD // 0) | add) } }) | from_entries),
    errors: map(select(.is_error == true) | .result) }' "$DIR"/turn-*.json > "$DIR/meta.json"
echo "done $TASK-$ARM: $(jq -c '{wallSeconds, userTurns, costUsd}' "$DIR/meta.json")"
