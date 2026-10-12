#!/usr/bin/env bash
# Tests for skills/codex-review/run.sh using a fake codex binary.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/skills/codex-review/run.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MONARCH_POLL_SECONDS=1

fails=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi
}

# Fake codex: behavior chosen by FAKE_MODE. Writes fixture JSON to the -o path.
cat > "$TMP/codex" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "login" ]; then [ "${FAKE_MODE:-}" = "loggedout" ] && exit 1; exit 0; fi
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
cat > /dev/null
case "${FAKE_MODE:-}" in
  ok) echo '{"findings":[{"severity":"major","category":"correctness","file":"a.ts","line":3,"endLine":4,"problem":"p","fix":"f"}]}' > "$out" ;;
  slow) sleep 30 ;;
  crash) echo "boom" >&2; exit 7 ;;
esac
EOF
chmod +x "$TMP/codex"
export MONARCH_CODEX_BIN="$TMP/codex"
mkdir -p "$TMP/repo"

# success
id="$(FAKE_MODE=ok "$RUN" start --cd "$TMP/repo" --base main)"
outp="$("$RUN" wait "$id" --max 20)"; code=$?
check "success exit" 0 "$code"
check "success json" "major" "$(printf '%s' "$outp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).findings[0].severity))')"
check "prompt has base" "1" "$(grep -c 'git diff main...HEAD' "$id/prompt.md")"

# brief is injected
printf 'Goal: add modulo\n' > "$TMP/brief.md"
id="$(FAKE_MODE=ok "$RUN" start --cd "$TMP/repo" --base main --brief "$TMP/brief.md")"
check "prompt has brief" "1" "$(grep -c 'Goal: add modulo' "$id/prompt.md")"
"$RUN" wait "$id" --max 20 > /dev/null

# timeout
id="$(FAKE_MODE=slow "$RUN" start --cd "$TMP/repo" --base main --timeout 2)"
"$RUN" wait "$id" --max 20 > /dev/null 2>&1; code=$?
check "timeout exit" 3 "$code"

# still running
id="$(FAKE_MODE=slow "$RUN" start --cd "$TMP/repo" --base main --timeout 4)"
"$RUN" wait "$id" --max 1 > /dev/null 2>&1; code=$?
check "still running exit" 4 "$code"
"$RUN" wait "$id" --max 20 > /dev/null 2>&1

# crash
id="$(FAKE_MODE=crash "$RUN" start --cd "$TMP/repo" --base main)"
"$RUN" wait "$id" --max 20 > /dev/null 2>&1; code=$?
check "crash exit" 1 "$code"

# not logged in
FAKE_MODE=loggedout "$RUN" start --cd "$TMP/repo" --base main > /dev/null 2>&1; code=$?
check "not logged in exit" 2 "$code"

# not installed
MONARCH_CODEX_BIN="$TMP/missing-codex" "$RUN" start --cd "$TMP/repo" --base main > /dev/null 2>&1; code=$?
check "not installed exit" 2 "$code"

# usage
"$RUN" start --cd "$TMP/repo" > /dev/null 2>&1; code=$?
check "usage exit" 64 "$code"

[ "$fails" -eq 0 ] && echo "all codex-run tests passed" || { echo "$fails failed"; exit 1; }
