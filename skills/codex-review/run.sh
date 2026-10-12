#!/usr/bin/env bash
# Run a Codex review of <base>...HEAD in the background and collect JSON findings.
#
#   run.sh start --cd <dir> --base <branch> [--brief <file>] [--out <json>] [--timeout <seconds>]
#       Prints the run directory (the run id) and returns immediately.
#   run.sh wait <run-dir> [--max <seconds>]
#       Blocks until Codex finishes or --max seconds pass. Prints findings JSON on success.
#
# Exit codes: 0 ok, 1 codex failed, 2 skipped (not installed / not logged in),
#             3 timed out, 4 still running (wait only), 64 usage error.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX="${MONARCH_CODEX_BIN:-codex}"
POLL="${MONARCH_POLL_SECONDS:-5}"

usage() { sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 64; }

cmd_start() {
  local dir="" base="" brief="" out="" timeout=900
  while [ $# -gt 0 ]; do
    case "$1" in
      --cd) dir="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --brief) brief="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$dir" ] && [ -n "$base" ] || usage

  command -v "$CODEX" >/dev/null 2>&1 || { echo "codex not installed" >&2; exit 2; }
  "$CODEX" login status >/dev/null 2>&1 || { echo "codex not logged in (run: codex login)" >&2; exit 2; }

  dir="$(cd "$dir" && pwd)" || { echo "no such directory: $dir" >&2; exit 64; }
  local run="$dir/.monarch/codex/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$run"
  [ -n "$out" ] || out="$run/findings.json"
  echo "$out" > "$run/out_path"

  local brief_text=""
  if [ -n "$brief" ] && [ -f "$brief" ]; then
    brief_text="Brief (the intended change):"$'\n\n'"$(cat "$brief")"
  fi
  local tmpl prompt
  tmpl="$(cat "$HERE/prompt.md")"
  prompt="${tmpl//\{\{BASE\}\}/$base}"
  prompt="${prompt//\{\{BRIEF\}\}/$brief_text}"
  printf '%s\n' "$prompt" > "$run/prompt.md"

  # Detached supervisor: runs codex, enforces the timeout, writes the exit status.
  nohup bash -c '
    run="$1"; codex="$2"; dir="$3"; schema="$4"; out="$5"; timeout="$6"
    "$codex" exec -s read-only -C "$dir" --ephemeral --output-schema "$schema" -o "$out" - \
      < "$run/prompt.md" > "$run/log" 2>&1 &
    cpid=$!
    echo "$cpid" > "$run/pid"
    elapsed=0
    while kill -0 "$cpid" 2>/dev/null; do
      if [ "$elapsed" -ge "$timeout" ]; then
        echo timeout > "$run/timed_out"
        kill "$cpid" 2>/dev/null
        break
      fi
      sleep 1; elapsed=$((elapsed + 1))
    done
    wait "$cpid"; echo "$?" > "$run/status"
  ' _ "$run" "$CODEX" "$dir" "$HERE/findings.schema.json" "$out" "$timeout" \
    < /dev/null > /dev/null 2>&1 &

  echo "$run"
}

cmd_wait() {
  local run="${1:-}"; shift || true
  local max=540
  while [ $# -gt 0 ]; do
    case "$1" in
      --max) max="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$run" ] && [ -d "$run" ] || { echo "no such run: $run" >&2; exit 64; }

  local deadline=$((SECONDS + max))
  while [ ! -f "$run/status" ]; do
    [ "$SECONDS" -ge "$deadline" ] && { echo "still running: $run" >&2; exit 4; }
    sleep "$POLL"
  done

  if [ -f "$run/timed_out" ]; then
    echo "codex timed out; log: $run/log" >&2
    exit 3
  fi
  local code out
  code="$(cat "$run/status")"
  out="$(cat "$run/out_path")"
  if [ "$code" = "0" ] && [ -s "$out" ]; then
    cat "$out"
    exit 0
  fi
  echo "codex failed (exit $code); log: $run/log" >&2
  tail -n 5 "$run/log" >&2
  exit 1
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  *) usage ;;
esac
