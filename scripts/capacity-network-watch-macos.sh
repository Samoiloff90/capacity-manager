#!/bin/bash
# Capacity Planner: наблюдение за сетевыми соединениями на macOS (DEC-023, этап 4).
# Без установки и без sudo: только bash 3.2 и системные nettop, netstat, lsof, ps, pgrep.
#
# Для пользователя:
#   bash ~/Downloads/capacity-network-watch-macos.sh
# Скрипт запускает «Capacity Planner.app» из ~/Applications (или --app ПУТЬ), раз в секунду
# записывает соединения приложения и его процессов WebKit, пока приложение не закроется,
# и сохраняет отчёт рядом с собой. В отчёте только процессы, адреса и порты — без данных.
# Для CI: --pid PID --out ПАПКА [--max-seconds N] [--debug]
set -u

APP_PATH="$HOME/Applications/Capacity Planner.app"
OUT_DIR=""
ATTACH_PID=""
MAX_SECONDS=0
DEBUG=0
LAUNCH_TIMEOUT=60
TAIL_SECONDS=5
INTERRUPTED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_PATH="${2%/}"; shift 2 ;;
    --pid) ATTACH_PID="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --max-seconds) MAX_SECONDS="$2"; shift 2 ;;
    --debug) DEBUG=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OUT_DIR" ]; then OUT_DIR="$(cd "$(dirname "$0")" && pwd)"; fi
mkdir -p "$OUT_DIR" || { echo "Не удалось создать папку $OUT_DIR" >&2; exit 1; }
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
REPORT="$OUT_DIR/capacity-network-$STAMP.txt"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/capacity-network.XXXXXX")" || exit 1
RECORDS="$WORK/records"
PROCS="$WORK/procs"
: > "$RECORDS"
: > "$PROCS"
trap 'rm -rf "$WORK"' EXIT
# Ctrl+C stops watching but still writes the report.
trap 'INTERRUPTED=1' INT

say() { printf '%s\n' "$*"; }

# ps elapsed time ([[dd-]hh:]mm:ss) in seconds, -1 if the process is gone.
elapsed() {
  ps -p "$1" -o etime= 2>/dev/null | tr -d ' ' | awk -F'[-:]' '
    NF == 0 { print -1; exit }
    { s = $NF; if (NF >= 2) s += $(NF-1) * 60; if (NF >= 3) s += $(NF-2) * 3600; if (NF >= 4) s += $(NF-3) * 86400; print s }
    END { if (NR == 0) print -1 }'
}

# Remembers a watched process while it is alive: pid|name|marked.
remember() {
  name="$(ps -p "$1" -o comm= 2>/dev/null | sed 's#.*/##')"
  [ -n "$name" ] || name="(неизвестно)"
  echo "$1|$name|нет" >> "$PROCS"
}

# --- Find or start the application ------------------------------------------------------
if [ -n "$ATTACH_PID" ]; then
  APP_PID="$ATTACH_PID"
  MODE="подключение к запущенному процессу (--pid)"
  kill -0 "$APP_PID" 2>/dev/null || { say "Процесс $APP_PID не найден." >&2; exit 1; }
  APP_BINARY="$(ps -p "$APP_PID" -o comm= 2>/dev/null)"
  APP_VERSION="—"
  case "$APP_BINARY" in
    */Contents/MacOS/*)
      BUNDLE="${APP_BINARY%%/Contents/MacOS/*}"
      APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$BUNDLE/Contents/Info.plist" 2>/dev/null || echo —)" ;;
  esac
else
  MODE="запуск приложения скриптом"
  PLIST="$APP_PATH/Contents/Info.plist"
  if [ ! -f "$PLIST" ]; then
    say "Не найдено приложение: $APP_PATH"
    say "Перенесите «Capacity Planner.app» в ~/Applications или укажите путь: --app \"/путь/Capacity Planner.app\""
    exit 1
  fi
  EXE="$(plutil -extract CFBundleExecutable raw -o - "$PLIST")"
  APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$PLIST" 2>/dev/null || echo —)"
  BUNDLE_NAME="$(basename "$APP_PATH")"
  if pgrep -f "Contents/MacOS/$EXE" >/dev/null 2>&1; then
    say "Capacity Planner уже запущен. Закройте его и запустите скрипт снова."
    exit 1
  fi
  say "Запускаю Capacity Planner. Проверьте приложение как обычно, затем закройте его."
  open "$APP_PATH" || { say "macOS не открыла приложение."; exit 1; }
  APP_PID=""
  waited=0
  while [ -z "$APP_PID" ] && [ "$waited" -lt "$LAUNCH_TIMEOUT" ]; do
    for candidate in $(pgrep -f "Contents/MacOS/$EXE" 2>/dev/null); do
      # Any copy of this bundle, including a translocated one.
      case "$(ps -p "$candidate" -o comm= 2>/dev/null)" in
        */"$BUNDLE_NAME"/Contents/MacOS/*) APP_PID="$candidate" ;;
      esac
    done
    [ -z "$APP_PID" ] && { sleep 1; waited=$((waited + 1)); }
  done
  if [ -z "$APP_PID" ]; then
    say "Приложение не запустилось за $LAUNCH_TIMEOUT с. Возможно, macOS заблокировала его:"
    say "см. «Системные настройки → Конфиденциальность и безопасность» и README."
    exit 1
  fi
fi

# --- Sampling ---------------------------------------------------------------------------
WATCHED=" $APP_PID "
remember "$APP_PID"

# WebKit processes (WebContent, Networking, GPU) started with or after the app are adopted.
# Their parent is launchd, so the start time is the only link; quit Safari and Mail first.
# A process that has files of local.capacity-planner open is confirmed as ours.
adopt_webkit() {
  app_age="$(elapsed "$APP_PID")"
  [ "$app_age" -ge 0 ] 2>/dev/null || return 0
  for p in $(pgrep -f 'com\.apple\.WebKit\.' 2>/dev/null); do
    case "$WATCHED" in *" $p "*) continue ;; esac
    age="$(elapsed "$p")"
    [ "$age" -ge 0 ] 2>/dev/null || continue
    if [ "$age" -le $((app_age + 2)) ]; then WATCHED="$WATCHED$p "; remember "$p"; fi
  done
}

confirm_webkit() {
  while IFS='|' read -r p name mark; do
    [ "$mark" = "да" ] && continue
    case "$name" in com.apple.WebKit.*) ;; *) continue ;; esac
    if lsof -p "$p" +c 0 2>/dev/null | grep -q 'local\.capacity-planner'; then
      sed -i '' "s/^$p|\(.*\)|нет\$/$p|\1|да/" "$PROCS"
    fi
  done < "$PROCS"
}

sample() {
  pids="$WATCHED"
  csv="$(echo $pids | tr ' ' ',')"
  # nettop: process rows "name.pid", connection rows contain "<->" (tcp4/tcp6/udp4/…).
  nettop -L 1 -n -x 2>/dev/null > "$WORK/nettop" || true
  [ "$DEBUG" -eq 1 ] && cat "$WORK/nettop" >> "$OUT_DIR/raw-nettop-$STAMP.csv"
  awk -F, -v pids="$pids" '
    NR == 1 { next }
    $2 ~ /<->/ {
      if (keep) { split($2, c, " "); n = split($2, ends, "<->"); print "nettop|" pid "|" c[1] "|" ends[n] "|" $4 }
      next
    }
    $2 ~ /\.[0-9]+$/ { n = split($2, a, "."); pid = a[n]; keep = index(pids, " " pid " ") > 0 }
  ' "$WORK/nettop" >> "$RECORDS"
  # lsof: -a makes -i and -p an AND.
  lsof -a -i -n -P +c 0 -p "$csv" 2>/dev/null | awk 'NR > 1 {
    name = $9; n = split(name, e, "->"); remote = (n > 1) ? e[2] : "(без удалённого адреса: " name ")"
    print "lsof|" $2 "|" $8 "|" remote "|" $10 }' >> "$RECORDS"
  # netstat -vv: "process:pid" and "eprocess:epid" (effective owner of delegated sockets).
  # "Local Address"/"Foreign Address" are two header words but one data field each.
  netstat -anvv -p tcp 2>/dev/null > "$WORK/netstat" || true
  [ "$DEBUG" -eq 1 ] && cat "$WORK/netstat" >> "$OUT_DIR/raw-netstat-$STAMP.txt"
  awk -v pids="$pids" '
    /Proto/ && /Foreign/ {
      shift = 0
      for (i = 1; i <= NF; i++) {
        if ($i == "Address") shift++
        col = i - shift
        if ($i == "pid") pc = col; else if ($i == "epid") ec = col
        else if ($i ~ /^process:pid/) ppc = col; else if ($i ~ /^eprocess:epid/) epc = col
      }
      next
    }
    $1 ~ /^tcp/ {
      p = ""; e = ""
      if (ppc) { n = split($ppc, a, ":"); p = a[n] } else if (pc) { p = $pc }
      if (epc) { n = split($epc, b, ":"); e = b[n] } else if (ec) { e = $ec }
      if (index(pids, " " p " ") || (e != "" && index(pids, " " e " "))) print "netstat|" p "|" $1 "|" $5 "|" $6
    }
  ' "$WORK/netstat" >> "$RECORDS"
}

START=$(date +%s)
SAMPLES=0
say "Наблюдаю за сетью (процесс $APP_PID). Остановить досрочно — Ctrl+C."
while kill -0 "$APP_PID" 2>/dev/null && [ "$INTERRUPTED" -eq 0 ]; do
  adopt_webkit
  confirm_webkit
  sample
  SAMPLES=$((SAMPLES + 1))
  if [ "$MAX_SECONDS" -gt 0 ] && [ $(( $(date +%s) - START )) -ge "$MAX_SECONDS" ]; then
    say "Достигнут предел наблюдения $MAX_SECONDS с."
    break
  fi
  sleep 1
done
# WebKit processes can outlive the window for a few seconds.
i=0
while [ "$i" -lt "$TAIL_SECONDS" ] && [ "$INTERRUPTED" -eq 0 ]; do
  confirm_webkit; sample; SAMPLES=$((SAMPLES + 1)); sleep 1; i=$((i + 1))
done
DURATION=$(( $(date +%s) - START ))

# --- Report -----------------------------------------------------------------------------
{
  say "Capacity Planner — наблюдение за сетью на macOS"
  say "Дата: $(date '+%Y-%m-%d %H:%M:%S')"
  say "macOS: $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"
  say "Версия приложения: $APP_VERSION"
  say "Режим: $MODE"
  say "Наблюдение: $DURATION с, выборок: $SAMPLES$([ "$INTERRUPTED" -eq 1 ] && echo ', остановлено Ctrl+C')"
  say ""
  say "Удалённые адреса (источник | pid | протокол | адрес | состояние | выборок):"
  if [ -s "$RECORDS" ]; then
    sort "$RECORDS" | uniq -c | sort -rn | awk '{ n = $1; sub(/^ *[0-9]+ /, ""); print "  " $0 " | " n }'
  else
    say "  соединений не обнаружено"
  fi
  say ""
  say "Процессы (pid | имя | открыты файлы local.capacity-planner):"
  while IFS='|' read -r p name mark; do
    case "$name" in
      com.apple.WebKit.*)
        if [ "$mark" = "да" ]; then say "  $p | $name | да"
        else say "  $p | $name | нет — может принадлежать другому приложению"; fi ;;
      *) say "  $p | $name | приложение" ;;
    esac
  done < "$PROCS"
  say ""
  say "Адреса 127.0.0.1 и ::1 — локальные. Внешние адреса процессов WebKit — фоновые запросы"
  say "системного движка (DEC-023). В netstat адрес и порт разделены точкой (1.2.3.4.443)."
  say "Пришлите этот файл разработчику; данных команды в нём нет."
} > "$REPORT"

say ""
case "$REPORT" in "$HOME"/*) SHOWN="~${REPORT#"$HOME"}" ;; *) SHOWN="$REPORT" ;; esac
say "Готово. Отчёт: $SHOWN"
if [ -z "$ATTACH_PID" ]; then open -R "$REPORT" 2>/dev/null || true; fi
exit 0
