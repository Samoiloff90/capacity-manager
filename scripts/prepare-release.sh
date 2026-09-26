#!/usr/bin/env bash
# CI only: checks the downloaded release files in DIR and writes the release notes.
# Runs on every build (job release-check) and again before publishing (job release), so the
# release path is exercised before any tag is pushed.
# Usage: bash scripts/prepare-release.sh <version> <dir> <notes-file>
set -euo pipefail
version="$1"
dir="$2"
notes="$3"

cp scripts/capacity-network-watch-macos.sh "$dir/"
expected="$(printf '%s\n' \
  "Capacity-Planner-$version-macos-arm64.zip" \
  "Capacity-Planner-$version-macos-arm64.zip.sha256" \
  "Capacity-Planner-$version-windows-x64-system-webview2.zip" \
  "Capacity-Planner-$version-windows-x64-system-webview2.zip.sha256" \
  "capacity-network-watch-macos.sh" | sort)"
actual="$(ls -1 "$dir" | sort)"
if [ "$actual" != "$expected" ]; then
  echo "::error title=Release files::expected: $(echo $expected) / got: $(echo $actual)"
  exit 1
fi
( cd "$dir" && sha256sum -c ./*.sha256 )

source_notes="docs/releases/v$version.md"
{
  if [ -f "$source_notes" ]; then
    cat "$source_notes"
  else
    echo "Описания $source_notes нет: это проверочный прогон без тега."
  fi
  echo
  echo "## Контрольные суммы SHA-256"
  echo
  echo "Проверка: на Mac — \`shasum -a 256 <файл>\` в «Терминале», на Windows — \`Get-FileHash <файл>\` в PowerShell."
  echo
  echo "| Файл | SHA-256 |"
  echo "| --- | --- |"
  ( cd "$dir" && for f in *.zip capacity-network-watch-macos.sh; do
      echo "| \`$f\` | \`$(sha256sum "$f" | cut -d' ' -f1)\` |"
    done )
} > "$notes"
echo "Release files for $version are complete and match their checksums."
