# Finds the node to run the Master with. Sourced by self-upgrade.sh and keepalive.sh (see
# docs/running.md); it only defines functions. Those scripts define log <message> and
# pick <zh> <en>, which use_node calls.
#
# A version manager such as nvm deletes the node a Master was started with when that version is
# uninstalled, and a path to it (given as an argument, or first in an inherited PATH) then leads
# nowhere. use_node <node> <package.json> takes the first of these that runs and has a version
# package.json's engines.node allows:
#   1. <node>: a path, or a name looked up in PATH (empty means node);
#   2. each node in PATH, in order;
#   3. nvm's default version: alias/default under ${NVM_DIR} (~/.nvm without it), followed through
#      aliases (lts/*, an alias of an alias) to the highest installed version it names (v26, 26,
#      24.22; node and stable name the highest of all);
#   4. the usual places: the directories in ${ARES1_NODE_DIRS} (separated by colons), by default
#      /opt/homebrew/bin and /usr/local/bin.
# The node found is in ${node}, and its directory goes first in PATH (exported), so that npm and
# everything the Master starts use the same one. When it is not <node>, a line in the log says
# which version is used instead, and where. When none is found it fails, leaving ${node} as it
# was; ${node_wanted} is engines.node then, for the caller's message.
#
# Only ranges of the form >=X, >=X.Y or >=X.Y.Z are understood; with any other range, or without
# one, a node only has to be an executable file, and its version is not asked.

# Variables are always written as ${name}: bash would read a following non-ASCII character
# (e.g. a Chinese parenthesis) as part of the name.

# The first line node prints for --version, e.g. v24.22.3; fails when it does not run.
node_version_of() {
  local out
  out=$("$1" --version 2>/dev/null) || return 1
  printf '%s' "${out}" | head -n 1 | tr -d '[:space:]'
}

# package.json's engines.node, e.g. >=24; nothing without one.
engines_node() {
  [ -f "$1" ] || return 0
  tr -d '\r\n' <"$1" 2>/dev/null |
    sed -n 's/.*"engines"[[:space:]]*:[[:space:]]*{[^}]*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

# Whether version $1 (v24.22.3) is allowed by range $2. A range it does not understand allows
# everything; a version that is not one (no digits) is allowed by no range it understands.
version_allowed() {
  local want=${2//[[:space:]]/} have=${1#v} i a b
  case "${want}" in
    '>='*) want=${want#>=} ;;
    *) return 0 ;;
  esac
  want=${want#v}
  case "${want}" in '' | *[!0-9.]*) return 0 ;; esac
  # Pre-release and build suffixes (24.0.0-rc.1) do not count.
  have=${have%%[-+]*}
  case "${have}" in '' | *[!0-9.]*) return 1 ;; esac
  local IFS=.
  local -a w h
  read -r -a w <<<"${want}"
  read -r -a h <<<"${have}"
  for i in 0 1 2; do
    a=${h[i]:-0}
    b=${w[i]:-0}
    [ "$((10#${a}))" -gt "$((10#${b}))" ] && return 0
    [ "$((10#${a}))" -lt "$((10#${b}))" ] && return 1
  done
  return 0
}

# Whether $1 is a node to use with range $2 (engines.node; empty for none).
node_usable() {
  [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
  case "${2//[[:space:]]/}" in
    '>='*) version_allowed "$(node_version_of "$1")" "$2" ;;
    *) return 0 ;;
  esac
}

# The node of nvm's default version, if it is installed.
nvm_default_node() {
  local nvm=${NVM_DIR:-${HOME}/.nvm} value prefix best dir version depth=0
  [ -f "${nvm}/alias/default" ] || return 1
  value=$(head -n 1 "${nvm}/alias/default" 2>/dev/null | tr -d '[:space:]')
  while :; do
    depth=$((depth + 1))
    [ "${depth}" -le 10 ] || return 1
    case "${value}" in
      node | stable)
        prefix=
        break
        ;;
      v[0-9]* | [0-9]*)
        prefix=${value#v}
        break
        ;;
      '' | system | iojs* | /* | *..*) return 1 ;;
    esac
    # Another alias, e.g. lts/* (a file named so) or lts/jod.
    [ -f "${nvm}/alias/${value}" ] || return 1
    value=$(head -n 1 "${nvm}/alias/${value}" 2>/dev/null | tr -d '[:space:]')
  done
  best=
  for dir in "${nvm}/versions/node"/v*; do
    [ -x "${dir}/bin/node" ] || continue
    version=${dir##*/v}
    if [ -n "${prefix}" ]; then
      case "${version}" in "${prefix}" | "${prefix}".*) ;; *) continue ;; esac
    fi
    if [ -z "${best}" ] || version_allowed "${version}" ">=${best}"; then best=${version}; fi
  done
  [ -n "${best}" ] || return 1
  printf '%s\n' "${nvm}/versions/node/v${best}/bin/node"
}

# Sets ${found_node} to the node to use (see the top of this file); ${node_wanted} is
# engines.node of package.json $2, ${found_given} is yes when the node is the one given as $1.
find_node() {
  local given=${1:-node} candidate dir
  local -a dirs
  node_wanted=$(engines_node "$2")
  found_node=
  found_given=
  case "${given}" in
    */*) candidate=${given} ;;
    *) candidate=$(command -v "${given}" 2>/dev/null) || candidate= ;;
  esac
  if node_usable "${candidate}" "${node_wanted}"; then
    found_node=${candidate}
    found_given=yes
    return 0
  fi
  IFS=: read -r -a dirs <<<"${PATH}"
  for dir in "${dirs[@]}"; do
    [ -n "${dir}" ] || continue
    if node_usable "${dir}/node" "${node_wanted}"; then
      found_node=${dir}/node
      return 0
    fi
  done
  candidate=$(nvm_default_node) || candidate=
  if node_usable "${candidate}" "${node_wanted}"; then
    found_node=${candidate}
    return 0
  fi
  IFS=: read -r -a dirs <<<"${ARES1_NODE_DIRS-/opt/homebrew/bin:/usr/local/bin}"
  for dir in "${dirs[@]}"; do
    [ -n "${dir}" ] || continue
    if node_usable "${dir}/node" "${node_wanted}"; then
      found_node=${dir}/node
      return 0
    fi
  done
  return 1
}

# Finds the node to use for <node> <package.json> and makes it ${node}, first in PATH.
use_node() {
  find_node "$1" "$2" || return 1
  node=${found_node}
  PATH="$(dirname -- "${node}"):${PATH}"
  export PATH
  if [ -z "${found_given}" ]; then
    local version
    version=$(node_version_of "${node}") || version=
    log "$(pick "node ${1:-（PATH 里的 node）} 用不了（不存在、不能执行或版本不满足 ${node_wanted:-要求}），改用 ${node}（${version:-版本未知}）" \
      "node ${1:-(in PATH)} cannot be used (missing, not executable or not ${node_wanted:-the version needed}); using ${node} (${version:-version unknown}) instead")"
  fi
}
