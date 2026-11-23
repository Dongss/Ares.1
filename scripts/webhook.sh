# Sends a notification to the webhook of config.yaml (notify.webhook) when the Master is down and
# cannot be started, so that it reaches a human away from this machine, or on a server without a
# desktop, when the Master cannot send it itself. Sourced by keepalive.sh and self-upgrade.sh (see
# docs/running.md); it only defines functions. Those scripts define ${home} (the Master's data
# directory), ${name} (the notification title), log <message> and pick <zh> <en>, which webhook
# uses.
#
# The scripts do not read config.yaml: the Master writes the webhook's settings to
# <home>/webhook.curl, a curl config file (src/notify/webhook.ts: webhookCurlConfig) only its
# owner may read, at start and on each reload of its configuration, and deletes it when there is
# no webhook. So the settings are those of the last Master that ran. Without the file, or without
# curl, nothing is sent. Nothing here needs node or jq: the node may be exactly what is missing.

# Variables are always written as ${name}: bash would read a following non-ASCII character
# (e.g. a Chinese parenthesis) as part of the name.

# Sets ${tilded} to text $1 with paths that start with the home directory (${HOME}) starting with
# ~ instead, as redactForGitHub (src/github/redact.ts) does for what the Master sends: the system
# user name stays private. Not where the home directory goes on as a longer name (/home/me2) or
# sits inside another path (/mnt/home/me). Matched as plain text: the home directory may hold
# characters special to patterns. Nothing changes without a home directory, or with / as one.
webhook_tilde() {
  local rest=${1} user_home=${HOME:-} out='' before last next
  while [ "${user_home%/}" != "${user_home}" ]; do user_home=${user_home%/}; done
  case "${user_home}" in
    /?*) ;;
    *)
      tilded=${rest}
      return
      ;;
  esac
  while [[ "${rest}" == *"${user_home}"* ]]; do
    before=${rest%%"${user_home}"*}
    rest=${rest#*"${user_home}"}
    out=${out}${before}
    last=${before: -1}
    next=${rest:0:1}
    case "${last}" in [A-Za-z0-9_./\\-])
      out=${out}${user_home}
      continue
      ;;
    esac
    case "${next}" in [A-Za-z0-9_-])
      out=${out}${user_home}
      continue
      ;;
    esac
    if [ "${next}" = . ]; then
      case "${rest:1:1}" in [A-Za-z0-9_-])
        out=${out}${user_home}
        continue
        ;;
      esac
    fi
    out=${out}'~'
  done
  tilded=${out}${rest}
}

# Prints text $1 as a JSON string, quotes included: quotes, backslashes and the control
# characters 0x01-0x1f (line breaks and tabs among them) escaped; bash strings hold no 0x00. DEL
# (0x7f) is left as it is: JSON only requires escaping below 0x20, and JSON.stringify leaves it
# too. Byte by byte, so that any text (Chinese too) gives valid JSON whatever the locale.
webhook_json() {
  printf '%s\n' "${1}" | LC_ALL=C awk '
    BEGIN {
      for (i = 1; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
      esc["\""] = "\\\""
      esc["\\"] = "\\\\"
      esc["\t"] = "\\t"
      esc["\r"] = "\\r"
      printf "%s", "\""
    }
    {
      if (NR > 1) printf "%s", "\\n"
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        printf "%s", ((c in esc) ? esc[c] : c)
      }
    }
    END { printf "%s", "\"" }'
}

# webhook <message> <event type>: POSTs the notification that the Master is down to the webhook,
# once, waiting at most ten seconds. With format: json (the default) the body has the fields the
# Master sends (WebhookPayload in src/notify/webhook.ts) with kind master_down and about master;
# with format: text it is "title\nmessage". A failure gets a line in the log with curl's exit code
# only (what curl says may name the address), is not retried and changes nothing for the caller.
# curl reads the user's own config (~/.curlrc, or the one under ${CURL_HOME} or ${XDG_CONFIG_HOME})
# before anything else, and -K does not skip it. -q, which curl only takes as its first argument,
# does: only the settings the Master left are used, so a proxy, a trace, extra headers or the like
# set there can neither change the request nor write its address and headers (tokens) to a file.
webhook() {
  local file=${home}/webhook.curl format title body text payload code
  [ -f "${file}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  format=$(sed -n 's/^# ares1-format:[[:space:]]*\([a-z]*\).*/\1/p' "${file}" 2>/dev/null |
    head -n 1)
  webhook_tilde "${name}"
  title=${tilded}
  webhook_tilde "${1}"
  body=${tilded}
  text=${title}$'\n'${body}
  if [ "${format}" = text ]; then
    payload=${text}
  else
    payload='{"kind":"master_down"'
    payload=${payload},'"title":'$(webhook_json "${title}")
    payload=${payload},'"body":'$(webhook_json "${body}")
    payload=${payload},'"text":'$(webhook_json "${text}")
    payload=${payload},'"runId":null,"about":"master"'
    payload=${payload},'"eventType":'$(webhook_json "${2:-}")
    payload=${payload},'"at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
  fi
  printf '%s' "${payload}" |
    curl -q -fsS --max-time 10 -K "${file}" -o /dev/null --data-binary @- >/dev/null 2>&1
  code=$?
  [ "${code}" -eq 0 ] && return 0
  log "$(pick "webhook 通知发送失败（curl 退出码 ${code}），不重试" \
    "Sending the webhook notification failed (curl exit code ${code}); not retrying")"
  return 0
}
