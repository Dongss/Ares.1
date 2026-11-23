#!/usr/bin/env bash
# Upgrade the Master in place and restart it (config.yaml: upgrade.auto; see docs/running.md).
#
# Started detached by the Master, which exits right after. The Master runs a copy of this file
# so that `git pull` never rewrites the script while bash is reading it, and puts each new copy
# in place by renaming it over the old one: the next upgrade can start while this one still
# watches the new Master, and the file this one has open must not change under it. For the same
# reason everything that takes time happens in main(), which bash reads to the end before it
# runs it, and the script exits right after it without reading on.
#
#   self-upgrade.sh <install dir> <home> <old pid> <old commit> <result file> <node> <port> \
#                   [<name>] [<language>] [<target>]
#
# Waits for the old Master to exit, fast-forwards to <target>, installs and builds, starts the new
# Master and checks /api/health. Once it answers, the script watches it for a while (five minutes;
# ARES1_UPGRADE_WATCH sets the seconds): if it exits with a non-zero code meanwhile (a crash, an
# uncaught exception, killed by a signal), that counts as a failed start. An exit with code 0 is a
# deliberate stop (SIGTERM or Ctrl-C, or the new Master handing over to the next upgrade) and ends
# the watch without rolling back, as does a new Master still running at its end.
# If any step fails it goes back to <old commit>, builds and starts that, without watching it.
#
# `npm ci` deletes node_modules before it installs, so with the npm registry down (or the network,
# or a proxy) the new version cannot be installed and the old one, rolled back to, would have no
# dependencies left to start with. So before pulling, the script renames node_modules to
# node_modules.ares1-prev (a rename, not a copy; ignored by git), and a rollback renames it back
# and only runs `npm run build`, rebuilding the old version's dist with the dependencies it had,
# without downloading anything. Only without that backup (no node_modules before the upgrade)
# does a rollback install with `npm ci` as before. The backup is deleted once the watch ends with
# the new Master still running. It is kept when the new Master exits with code 0: that may be the
# new Master handing over to the next upgrade, whose script may already have renamed
# node_modules to the same name. The next upgrade deletes a backup left over before it makes its
# own.
#
# The result file tells the next Master how it went, on failure with the end of the output that
# says why (`detail`: what pulling and building printed, or what the new Master printed before it
# was stopped or exited); a human is notified only if nothing could be started at all: by a
# system notification, and to the webhook of config.yaml when the last Master that ran left its
# settings (webhook.sh, which the Master copies next to this copy as it does find-node.sh).
# <name> is the project's display name (src/brand.ts), used as the notification title;
# <language> (zh or en, config.yaml's language) picks the texts.
# <target> is the commit the Master found on origin (already fetched); a failure is reported
# against it, so that the Master does not try it again. Without it the script pulls instead and
# reports whatever HEAD is. A <target> equal to <old commit> restarts the Master on the same
# version, e.g. because the node it ran on was deleted.
#
# <node> is the old Master's node. A version manager (nvm) may have deleted it meanwhile, so
# before building, starting and rolling back the script looks for the node to use (use_node from
# find-node.sh, which the Master copies next to this copy): <node> while it works, else another
# whose version package.json allows. Its directory goes first in PATH, so that npm is the one
# that comes with it. When no node can be found, or npm cannot be (the build exits with 127), the
# failure is the environment's, not the commit's: the result says so (`env`), and the Master
# tries the same commit again later instead of giving it up.

set -u
# Variables are always written as ${name}: bash would read a following non-ASCII character
# (e.g. a Chinese parenthesis) as part of the name.

dir=$1 home=$2 pid=$3 old=$4 result=$5 node=$6 port=$7 name=${8:-Master} lang=${9:-zh}
target=${10:-}

# Read whole now, before anything changes the install directory; the install directory's copy
# only stands in for a missing one next to this script.
# shellcheck source=find-node.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/find-node.sh" 2>/dev/null ||
  . "${dir}/scripts/find-node.sh" 2>/dev/null ||
  use_node() { [ -x "${node}" ]; }
# Likewise the webhook notification; without it only the system notification is sent.
# shellcheck source=webhook.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/webhook.sh" 2>/dev/null ||
  . "${dir}/scripts/webhook.sh" 2>/dev/null ||
  webhook() { :; }

# How long the new Master is watched after it answered, in seconds.
watch=${ARES1_UPGRADE_WATCH:-300}
case "${watch}" in '' | *[!0-9]*) watch=300 ;; esac
# How often it is looked at meanwhile, in seconds.
every=5

# The text of the Master's language: pick <zh> <en>.
pick() { if [ "${lang}" = en ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

log() { echo "[$(date '+%F %T')] $*"; }

# A system notification: osascript on macOS, notify-send (libnotify) on Linux, else nothing.
notify() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"${name}\" sound name \"default\"" \
      >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name "${name}" "${name}" "$1" >/dev/null 2>&1 || true
  fi
}

# No Master runs and the script could not start one: a system notification, and the webhook.
master_down() {
  notify "$1"
  webhook "$1" upgrade.master_down
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

# Writes the result file from its arguments:
# <file> <ok> <from> <to> <message> [<detail file>] [<env>].
# The detail is the end of the detail file: its last lines, capped in length. <env> is true when
# the failure is the environment's (no node or npm). node builds the JSON, so that quotes,
# backslashes and line breaks in the output cannot break it; the values come in as arguments,
# never as code.
result_js='
const fs = require("node:fs");
const [file, ok, from, to, message, detailFile, env] = process.argv.slice(1);
const result = { ok: ok === "true", from, to, message };
if (env === "true") result.env = true;
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

write_result() { # ok to message [detail file] [env]
  rm -f "${result}"
  "${node}" -e "${result_js}" -- "${result}" "$1" "${old}" "$2" "$3" "${4:-}" "${5:-}"
  # If node could not write it (none was found, say), the next Master still learns how it went,
  # without the detail.
  local env_field=
  [ "${5:-}" = true ] && env_field=',"env":true'
  [ -s "${result}" ] ||
    printf '{"ok":%s,"from":"%s","to":"%s","message":"%s"%s}\n' "$1" "${old}" "$2" "$3" \
      "${env_field}" >"${result}"
}

# Fast-forward only: to <target>, so that the commit started is the one the Master planned.
advance() {
  if [ -n "${target}" ]; then git merge -q --ff-only "${target}"; else git pull --ff-only -q; fi
}

build() { npm ci --no-audit --no-fund && npm run build; }

# Where node_modules from before the upgrade waits in the install directory, for a rollback.
# The repository's .gitignore lists it; the script never changes .gitignore, which would leave
# the install directory with local changes.
prev=node_modules.ares1-prev
# Set when this run moved node_modules to ${prev}, so that a rollback never puts back a backup
# some earlier run left behind.
backed_up=

# Moves node_modules aside before anything can delete it. A backup an earlier upgrade left
# behind goes first; if it cannot be removed, or node_modules cannot be moved, nothing is backed
# up (renaming onto an existing directory would move node_modules into it) and the upgrade goes
# on as without one.
back_up_deps() {
  rm -rf "${prev}"
  [ -d node_modules ] || return 0
  [ -e "${prev}" ] && return 0
  mv node_modules "${prev}" && backed_up=true
}

# Puts back the node_modules back_up_deps moved aside, in place of whatever the new version
# installed (perhaps half of it); ${restored} is set when it did.
restore_deps() {
  restored=
  [ -n "${backed_up}" ] && [ -d "${prev}" ] || return 0
  rm -rf node_modules
  [ -e node_modules ] && return 0
  mv "${prev}" node_modules || return 0
  restored=true
  log "$(pick "放回了升级前的依赖（node_modules），不重新安装" \
    "Put back the dependencies from before the upgrade (node_modules) instead of installing them again")"
}

# Set when the upgrade failed for want of node or npm rather than because of the commit.
env_failed=

# Finds the node for the version checked out now (find-node.sh); a missing one is the
# environment's failure, said in the output kept for the result.
node_ready() {
  use_node "${node}" package.json && return 0
  env_failed=true
  {
    pick "找不到能用的 node：${node} 不存在、不能执行或版本不满足要求，PATH、nvm 的默认版本和常见的安装位置里也没有${node_wanted:+满足 ${node_wanted} 的}可用的 node" \
      "No usable node found: ${node} is missing, not executable or of the wrong version, and there is none${node_wanted:+ of ${node_wanted}} in PATH, nvm's default version or the usual places"
    echo
  } | tee -a "${out}"
  return 1
}

# Builds with the npm next to the node found; without one (or when the build says a command was
# not found, exit code 127) the failure is the environment's.
build_new() {
  if ! command -v npm >/dev/null 2>&1; then
    env_failed=true
    {
      pick "找不到 npm（PATH：${PATH}）" "npm not found (PATH: ${PATH})"
      echo
    } | tee -a "${out}"
    return 127
  fi
  captured build
  local code=$?
  [ "${code}" -eq 127 ] && env_failed=true
  return "${code}"
}

# Starts the Master in the background of this shell, not of a subshell, so that it is this
# script's child and `wait` can tell how it exited; its pid goes in ${started}.
start() {
  nohup "${node}" dist/cli.js --home "${home}" >>"${home}/master.out" 2>&1 &
  started=$!
}

# Waits up to a minute for /api/health to answer; ${waited} is how many seconds that took.
healthy() {
  waited=0
  while [ "${waited}" -lt 60 ]; do
    curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Watches the Master with pid $1 for ${watch} seconds, looking every ${every} seconds; the time
# is counted from the looks, not read from the clock. If it exits meanwhile, ${code} is its exit
# code (128 + the signal's number when a signal killed it); if it is still running at the end,
# ${code} is empty. ${watched} is how many seconds it was watched.
watch_new() {
  watched=0 code=
  while kill -0 "$1" 2>/dev/null; do
    [ "${watched}" -ge "${watch}" ] && return
    sleep "${every}"
    watched=$((watched + every))
  done
  wait "$1"
  code=$?
}

main() {
  if [ "${target}" = "${old}" ]; then
    log "$(pick "在当前版本 ${old} 上重启 Master，等待旧的 Master（pid ${pid}）退出" \
      "Restarting the Master on the same version ${old}, waiting for the old Master (pid ${pid}) to exit")"
  else
    log "$(pick "开始升级（当前 ${old}），等待旧的 Master（pid ${pid}）退出" \
      "Upgrading (now at ${old}), waiting for the old Master (pid ${pid}) to exit")"
  fi
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
    master_down "$(pick "自动升级失败：找不到安装目录 ${dir}" \
      "Automatic upgrade failed: install directory ${dir} not found")"
    exit 1
  }

  # Before advance and node_ready too: a rollback after either of them failing then needs no
  # download either. node_modules is not tracked, so moving it changes nothing for git.
  back_up_deps

  if captured advance && node_ready && build_new; then
    new=$(git rev-parse HEAD)
    # Written before starting, so the new Master finds it on startup. If the new Master exits
    # with an error later, a failure replaces it, which the Master started after the rollback
    # reads.
    write_result true "${new}" ""
    # Where this start's output begins in master.out, which holds earlier runs' output too.
    logged=$(wc -c <"${home}/master.out" 2>/dev/null) || logged=0
    start
    newpid=${started}
    if healthy; then
      log "$(pick "新版本 ${new} 已启动（pid ${newpid}），观察 ${watch} 秒" \
        "The new version ${new} is up (pid ${newpid}), watching it for ${watch} seconds")"
      watch_new "${newpid}"
      if [ -z "${code}" ]; then
        # The new version runs on its own dependencies; the old ones are not needed any more.
        rm -rf "${prev}"
        log "$(pick "已升级到 ${new}（pid ${newpid}）" "Upgraded to ${new} (pid ${newpid})")"
        exit 0
      fi
      if [ "${code}" -eq 0 ]; then
        log "$(pick "新版本 ${new} 正常退出（退出码 0，有意停止），不回退" \
          "The new version ${new} exited cleanly (exit code 0, stopped on purpose); not rolling back")"
        exit 0
      fi
      # Why it exited is in what the new Master printed, not in the build's output.
      tail -c "+$((logged + 1))" "${home}/master.out" >"${out}" 2>/dev/null
      # Whole minutes, rounded up, from starting it to finding it gone.
      minutes=$(((waited + watched + 59) / 60))
      [ "${minutes}" -ge 1 ] || minutes=1
      unit=minutes
      [ "${minutes}" -eq 1 ] && unit=minute
      msg=$(pick "新版本 ${new:0:7} 启动后 ${minutes} 分钟内退出（退出码 ${code}），已回退到 ${old:0:7}" \
        "The new version ${new:0:7} exited within ${minutes} ${unit} of starting (exit code ${code}); rolled back to ${old:0:7}")
    else
      kill "${newpid}" 2>/dev/null
      sleep 3
      kill -9 "${newpid}" 2>/dev/null
      # Why it did not come up is in what the new Master printed, not in the build's output.
      tail -c "+$((logged + 1))" "${home}/master.out" >"${out}" 2>/dev/null
      msg=$(pick "新版本 ${new:0:7} 启动后没有响应，已回退到 ${old:0:7}" \
        "The new version ${new:0:7} did not respond after starting; rolled back to ${old:0:7}")
    fi
  else
    # Not HEAD: if the fast-forward failed, HEAD is still <old commit>.
    new=${target:-$(git rev-parse HEAD)}
    if [ -n "${env_failed}" ]; then
      msg=$(pick "构建 ${new:0:7} 时找不到能用的 node 或 npm（运行环境的问题，不是这个提交的问题，环境恢复后会再试），已回退到 ${old:0:7}" \
        "Building ${new:0:7} found no usable node or npm (a problem of the environment, not of the commit; it is tried again once that is fixed); rolled back to ${old:0:7}")
    else
      msg=$(pick "拉取或构建 ${new:0:7} 失败，已回退到 ${old:0:7}" \
        "Pulling or building ${new:0:7} failed; rolled back to ${old:0:7}")
    fi
  fi

  log "${msg}"
  write_result false "${new}" "${msg}" "${out}" "${env_failed}"
  git reset -q --hard "${old}"
  reset=$?
  # Whether or not the reset worked, and before looking for node: even a Master the script
  # cannot start now (keepalive.sh only runs node) needs its dependencies in place.
  restore_deps
  # The node may have changed since it was looked for, and the old version may want another.
  if ! use_node "${node}" package.json; then
    log "$(pick "找不到能用的 node，回退后无法启动 Master" "No usable node found, so the Master cannot be started after the rollback")"
    master_down "$(pick "自动升级失败，回退后找不到能用的 node，Master 没能启动，请手动处理（日志：${home}/upgrade.log）" \
      "Automatic upgrade failed and no usable node was found to start the Master after the rollback; please handle it by hand (log: ${home}/upgrade.log)")"
    return
  fi
  # The old version's dist is rebuilt; with its dependencies put back that needs no download.
  # If the build fails, the Master is started all the same; if it does not come up, the
  # notification below says so.
  if [ "${reset}" -eq 0 ]; then
    if [ -n "${restored}" ]; then npm run build; else build; fi
  fi
  start
  if healthy; then
    log "$(pick "已回退到 ${old}" "Rolled back to ${old}")"
  else
    log "$(pick "回退后 Master 也没能启动" "The Master did not start after the rollback either")"
    master_down "$(pick "自动升级失败，回退后 Master 也没能启动，请手动处理（日志：${home}/upgrade.log）" \
      "Automatic upgrade failed and the Master did not start after the rollback; please handle it by hand (log: ${home}/upgrade.log)")"
  fi
}

# On one line, so that bash has read both before main starts, and nothing after them.
main; exit
