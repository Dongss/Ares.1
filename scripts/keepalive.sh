#!/usr/bin/env bash
# Keeps the Master running (see docs/running.md). A timer calls it every minute (launchd, a systemd
# timer or cron); each call looks once whether the Master answers, starts it if it is not running,
# and exits.
#
#   keepalive.sh <install dir> <home> [<port>] [<node>] [<name>]
#
# <port> defaults to config.yaml's `port` (4870 without one). <node> defaults to the node in PATH.
# When it does not run (a version manager such as nvm deleted it), another node whose version the
# install directory's package.json allows is used instead, and logged (use_node, find-node.sh): one
# in PATH, nvm's default version, or one in the usual places. Its directory goes first in PATH, so
# that the Master and the agents it starts find the same one. <name> is the notification title
# (the project's display name, default Master). config.yaml's `language` (zh or en) picks the
# texts.
#
# Two Masters on one home would both recover the same Runs, and the Master changes the database
# before it listens, so a second one does harm before it finds the port taken. So nothing is
# started when
#   - /api/health answers;
#   - an upgrade runs (self-upgrade.sh with this home): it starts or rolls back the Master itself;
#   - another call holds <home>/keepalive.lock (one older than five minutes is left over, and
#     taken over);
#   - a process runs `dist/cli.js --home <home>` without answering (hung, or still starting): it is
#     not killed, only logged;
#   - something else answers on the port: logged, and notified.
# Otherwise the Master is started in the install directory the way self-upgrade.sh starts it, and
# given up to a minute to answer /api/health. Each start, and anything amiss, gets a line with the
# time in <home>/keepalive.log; a Master that answers gets none, so calls every minute do not grow
# it. A Master that cannot be started is notified once, until it answers again.

set -u
# Variables are always written as ${name}: bash would read a following non-ASCII character
# (e.g. a Chinese parenthesis) as part of the name.

if [ $# -lt 2 ] || [ -z "${1}" ] || [ -z "${2}" ]; then
  echo '用法：keepalive.sh <安装目录> <数据目录> [<端口>] [<node>] [<通知标题>]' >&2
  echo 'Usage: keepalive.sh <install dir> <home> [<port>] [<node>] [<notification title>]' >&2
  exit 2
fi

dir=${1} home=${2} port=${3:-} node=${4:-} name=${5:-Master}
node_arg=${node}

# A top-level `key: value` of config.yaml, without quotes or a trailing comment.
setting() {
  sed -n "s/^${1}:[[:space:]]*['\"]\{0,1\}\([A-Za-z0-9_.-]*\).*/\1/p" "${home}/config.yaml" \
    2>/dev/null | head -n 1
}

lang=$(setting language)

# The text of the Master's language: pick <zh> <en>.
pick() { if [ "${lang}" = en ]; then printf '%s' "${2}"; else printf '%s' "${1}"; fi; }

# Absolute, since the Master is started from the install directory.
mkdir -p "${home}" 2>/dev/null
abs=$(CDPATH='' cd -- "${home}" 2>/dev/null && pwd) || {
  pick "无法使用数据目录 ${home}" "Cannot use the home directory ${home}" >&2
  echo >&2
  exit 2
}
home=${abs}

log_file=${home}/keepalive.log
lock=${home}/keepalive.lock
# There while a notification about this outage has been sent, so that it is sent once.
notified=${home}/keepalive.notified

log() { printf '[%s] %s\n' "$(date '+%F %T')" "${1}" >>"${log_file}"; }

# A system notification: osascript on macOS, notify-send (libnotify) on Linux, else nothing.
notify() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"${1}\" with title \"${name}\" sound name \"default\"" \
      >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name "${name}" "${name}" "${1}" >/dev/null 2>&1 || true
  fi
}

# Something a human has to look at: logged each time, notified once until the Master answers.
alert() {
  log "${1}"
  [ -e "${notified}" ] && return
  : >"${notified}"
  notify "$(pick "Master 停了，保活脚本没能把它启动起来：${1}（日志：${log_file}）" \
    "The Master is down and the keepalive script could not start it: ${1} (log: ${log_file})")"
}

# Finding node, shared with self-upgrade.sh; read whole now, as an upgrade may rewrite it later.
# shellcheck source=find-node.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/find-node.sh" || {
  alert "$(pick "找不到 $(dirname -- "${BASH_SOURCE[0]}")/find-node.sh" \
    "$(dirname -- "${BASH_SOURCE[0]}")/find-node.sh not found")"
  exit 1
}

# Asks /api/health. ${answer} is curl's exit code: 0 answered, 7 nothing listens on the port,
# anything else something listens but does not answer as a Master does.
ask() {
  curl -fsS --max-time 5 -o /dev/null "${url}" >/dev/null 2>&1
  answer=$?
  return "${answer}"
}

# Answered: a later outage is notified again.
answered() {
  rm -f "${notified}"
  exit 0
}

processes() { ps -A -ww -o pid= -o command= 2>/dev/null; }

# The pid of a process running this home's Master, answering or not (hung, still starting,
# started by hand). Matched as plain text: the home may hold characters special to patterns.
master_pid() {
  processes | while read -r pid cmd; do
    case "${cmd} " in
      *"dist/cli.js --home ${home} "* | *"dist/cli.js --home ${home}/ "*)
        echo "${pid}"
        break
        ;;
    esac
  done
}

# The pid of an upgrade of this home's Master: self-upgrade.sh (the copy in the home's data
# directory, or the install directory's) with the home among its arguments.
upgrade_pid() {
  processes | while read -r pid cmd; do
    case " ${cmd} " in
      *"self-upgrade.sh "*) ;;
      *) continue ;;
    esac
    case " ${cmd} " in
      *" ${home} "* | *" ${home}/ "*)
        echo "${pid}"
        break
        ;;
    esac
  done
}

# Takes <home>/keepalive.lock; fails while another call holds it.
take_lock() {
  mkdir "${lock}" 2>/dev/null && return 0
  # A call holds it for a minute or so; one five minutes old was left by a call that was killed.
  if [ -n "$(find "${lock}" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
    rmdir "${lock}" 2>/dev/null
    mkdir "${lock}" 2>/dev/null && return 0
  fi
  return 1
}

main() {
  if [ -n "${port}" ]; then
    case "${port}" in *[!0-9]*)
      pick "端口必须是数字：${port}" "The port must be a number: ${port}" >&2
      echo >&2
      exit 2
      ;;
    esac
  else
    port=$(setting port)
    case "${port}" in '' | *[!0-9]*) port=4870 ;; esac
  fi
  url=http://127.0.0.1:${port}/api/health

  if ! command -v curl >/dev/null 2>&1; then
    alert "$(pick "找不到 curl，无法检查 Master 是否在运行" \
      "curl not found, so whether the Master runs cannot be checked")"
    exit 1
  fi

  ask && answered
  # The upgrade script stops, starts and rolls back the Master itself.
  [ -n "$(upgrade_pid)" ] && exit 0

  take_lock || exit 0
  trap 'rmdir "${lock}" 2>/dev/null' EXIT
  # Another call may have started it meanwhile, or an upgrade begun.
  ask && answered
  [ -n "$(upgrade_pid)" ] && exit 0

  pid=$(master_pid)
  if [ -n "${pid}" ]; then
    log "$(pick "Master（pid ${pid}）在运行，但 ${url} 没有响应（卡住了，或者还在启动），不强行结束它" \
      "The Master (pid ${pid}) is running but ${url} does not answer (hung, or still starting); not killing it")"
    exit 0
  fi
  if [ "${answer}" -ne 7 ]; then
    alert "$(pick "端口 ${port} 被别的进程占着（${url} 没有按 Master 的方式响应），没有启动 Master" \
      "Port ${port} is taken by another process (${url} does not answer as a Master does); not starting the Master")"
    exit 0
  fi

  if ! use_node "${node}" "${dir}/package.json"; then
    alert "$(pick "找不到能用的 node（${node_arg:-PATH 里没有}；PATH、nvm 的默认版本和常见的安装位置里也没有${node_wanted:+满足 ${node_wanted} 的}可用的 node）" \
      "No usable node found (${node_arg:-not in PATH}; none${node_wanted:+ of ${node_wanted}} in PATH, nvm's default version or the usual places either)")"
    exit 1
  fi

  cd "${dir}" 2>/dev/null || {
    alert "$(pick "找不到安装目录 ${dir}" "Install directory ${dir} not found")"
    exit 1
  }

  # As self-upgrade.sh's start().
  nohup "${node}" dist/cli.js --home "${home}" >>"${home}/master.out" 2>&1 </dev/null &
  started=$!
  since=${SECONDS}
  until ask; do
    if ! kill -0 "${started}" 2>/dev/null; then
      wait "${started}"
      code=$?
      alert "$(pick "启动的 Master（pid ${started}）退出了（退出码 ${code}），输出见 ${home}/master.out" \
        "The Master it started (pid ${started}) exited (exit code ${code}); its output is in ${home}/master.out")"
      exit 1
    fi
    if [ $((SECONDS - since)) -ge 60 ]; then
      alert "$(pick "启动了 Master（pid ${started}），但一分钟内 ${url} 没有响应" \
        "Started the Master (pid ${started}), but ${url} did not answer within a minute")"
      exit 1
    fi
    sleep 1
  done
  log "$(pick "Master 没有在运行，已启动（pid ${started}，${dir}），$((SECONDS - since)) 秒后有响应" \
    "The Master was not running; started it (pid ${started}, ${dir}), answering after $((SECONDS - since)) s")"
  answered
}

# On one line, so that bash has read both before main starts: an upgrade may rewrite this file
# meanwhile, and nothing after them is read.
main; exit
