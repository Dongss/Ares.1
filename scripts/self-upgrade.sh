#!/usr/bin/env bash
# Upgrade the Master in place and restart it (config.yaml: upgrade.auto; see docs/running.md).
#
# Started detached by the Master, which exits right after; the Master runs a copy of this file
# so that `git pull` never rewrites the script while bash is reading it.
#
#   self-upgrade.sh <install dir> <home> <old pid> <old commit> <result file> <node> <port> \
#                   [<name>] [<language>] [<target>]
#
# Waits for the old Master to exit, fast-forwards to <target>, installs and builds, starts the new
# Master and checks /api/health. If any step fails it goes back to <old commit>, builds and starts
# that. The result file tells the next Master how it went, on failure with the end of the output
# that says why (`detail`: what pulling and building printed, or what the new Master printed
# before it was stopped); a system notification is sent only if nothing could be started at all.
# <name> is the project's display name (src/brand.ts), used as the notification title;
# <language> (zh or en, config.yaml's language) picks the texts.
# <target> is the commit the Master found on origin (already fetched); a failure is reported
# against it, so that the Master does not try it again. Without it the script pulls instead and
# reports whatever HEAD is.

set -u
# Variables are always written as ${name}: bash would read a following non-ASCII character
# (e.g. a Chinese parenthesis) as part of the name.

dir=$1 home=$2 pid=$3 old=$4 result=$5 node=$6 port=$7 name=${8:-Master} lang=${9:-zh}
target=${10:-}

# The text of the Master's language: pick <zh> <en>.
pick() { if [ "${lang}" = en ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

log() { echo "[$(date '+%F %T')] $*"; }

notify() {
  osascript -e "display notification \"$1\" with title \"${name}\" sound name \"default\"" \
    >/dev/null 2>&1 || true
}

# What pulling and building print, kept for the result's detail besides going to the log.
out=$(mktemp "${TMPDIR:-/tmp}/ares1-upgrade.XXXXXX" 2>/dev/null) || out="${result}.out"
: >"${out}"
trap 'rm -f "${out}"' EXIT

# Run a step with its output both in the log and in ${out}; fails if the step fails.
captured() {
  "$@" 2>&1 | tee -a "${out}"
  return "${PIPESTATUS[0]}"
}

# Writes the result file from its arguments: <file> <ok> <from> <to> <message> [<detail file>].
# The detail is the end of the detail file: its last lines, capped in length. node builds the
# JSON, so that quotes, backslashes and line breaks in the output cannot break it; the values come
# in as arguments, never as code.
result_js='
const fs = require("node:fs");
const [file, ok, from, to, message, detailFile] = process.argv.slice(1);
const result = { ok: ok === "true", from, to, message };
let detail = "";
try {
  if (detailFile) detail = fs.readFileSync(detailFile, "utf8");
} catch {}
detail = detail
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  .replace(/\r\n?/g, "\n")
  .trimEnd();
if (detail.trim()) {
  detail = detail.split("\n").slice(-60).join("\n");
  if (detail.length > 8000) detail = "…" + detail.slice(-8000);
  result.detail = detail;
}
fs.writeFileSync(file, JSON.stringify(result) + "\n");
'

write_result() { # ok to message [detail file]
  rm -f "${result}"
  "${node}" -e "${result_js}" -- "${result}" "$1" "${old}" "$2" "$3" "${4:-}"
  # If node could not write it, the next Master still learns how it went, without the detail.
  [ -s "${result}" ] ||
    printf '{"ok":%s,"from":"%s","to":"%s","message":"%s"}\n' "$1" "${old}" "$2" "$3" >"${result}"
}

# Fast-forward only: to <target>, so that the commit started is the one the Master planned.
advance() {
  if [ -n "${target}" ]; then git merge -q --ff-only "${target}"; else git pull --ff-only -q; fi
}

build() { npm ci --no-audit --no-fund && npm run build; }

start() {
  nohup "${node}" dist/cli.js --home "${home}" >>"${home}/master.out" 2>&1 &
  echo $!
}

healthy() {
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

log "$(pick "开始升级（当前 ${old}），等待旧的 Master（pid ${pid}）退出" \
  "Upgrading (now at ${old}), waiting for the old Master (pid ${pid}) to exit")"
for _ in $(seq 1 120); do
  kill -0 "${pid}" 2>/dev/null || break
  sleep 1
done
if kill -0 "${pid}" 2>/dev/null; then
  log "$(pick "旧的 Master 两分钟内没有退出，强制结束" \
    "The old Master did not exit within two minutes, killing it")"
  kill -9 "${pid}" 2>/dev/null
  sleep 1
fi

cd "${dir}" || {
  notify "$(pick "自动升级失败：找不到安装目录 ${dir}" \
    "Automatic upgrade failed: install directory ${dir} not found")"
  exit 1
}

if captured advance && captured build; then
  new=$(git rev-parse HEAD)
  # Written before starting, so the new Master finds it on startup.
  write_result true "${new}" ""
  # Where this start's output begins in master.out, which holds earlier runs' output too.
  logged=$(wc -c <"${home}/master.out" 2>/dev/null) || logged=0
  newpid=$(start)
  if healthy; then
    log "$(pick "已升级到 ${new}（pid ${newpid}）" "Upgraded to ${new} (pid ${newpid})")"
    exit 0
  fi
  kill "${newpid}" 2>/dev/null
  sleep 3
  kill -9 "${newpid}" 2>/dev/null
  # Why it did not come up is in what the new Master printed, not in the build's output.
  tail -c "+$((logged + 1))" "${home}/master.out" >"${out}" 2>/dev/null
  msg=$(pick "新版本 ${new:0:7} 启动后没有响应，已回退到 ${old:0:7}" \
    "The new version ${new:0:7} did not respond after starting; rolled back to ${old:0:7}")
else
  # Not HEAD: if the fast-forward failed, HEAD is still <old commit>.
  new=${target:-$(git rev-parse HEAD)}
  msg=$(pick "拉取或构建 ${new:0:7} 失败，已回退到 ${old:0:7}" \
    "Pulling or building ${new:0:7} failed; rolled back to ${old:0:7}")
fi

log "${msg}"
write_result false "${new}" "${msg}" "${out}"
git reset -q --hard "${old}" && build
start >/dev/null
if healthy; then
  log "$(pick "已回退到 ${old}" "Rolled back to ${old}")"
else
  log "$(pick "回退后 Master 也没能启动" "The Master did not start after the rollback either")"
  notify "$(pick "自动升级失败，回退后 Master 也没能启动，请手动处理（日志：${home}/upgrade.log）" \
    "Automatic upgrade failed and the Master did not start after the rollback; please handle it by hand (log: ${home}/upgrade.log)")"
fi
