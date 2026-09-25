#!/usr/bin/env bash
# CI only: runs a command, keeps its full output in $RUNNER_TEMP/logs/<name>.log and, on
# failure, publishes the error lines and the tail as ::error:: annotations. Job logs of
# this public repository need a GitHub login; annotations are readable without one.
# Usage: bash scripts/ci-run.sh <name> <command> [args...]
set -uo pipefail
name="$1"
shift
base="${RUNNER_TEMP:-.}"
if command -v cygpath >/dev/null 2>&1; then base="$(cygpath -u "$base")"; fi
mkdir -p "$base/logs"
log="$base/logs/$name.log"
"$@" 2>&1 | tee "$log"
code="${PIPESTATUS[0]}"
# Annotation values are single-line: encode %, CR and LF.
encode() { tr -d '\r' | sed 's/%/%25/g' | awk 'BEGIN { ORS = "%0A" } { print }'; }
if [ "$code" -ne 0 ]; then
  errors="$(grep -nE '^error|error TS[0-9]+|panicked at|FAILED|^failures:|Error:|FAIL[: ]|AssertionError|^Diff in' "$log" | head -n 40 | encode)"
  if [ -n "$errors" ]; then echo "::error title=${name}: errors::${errors}"; fi
  echo "::error title=${name}: failed with exit code ${code}::$(tail -n 40 "$log" | encode)"
fi
exit "$code"
