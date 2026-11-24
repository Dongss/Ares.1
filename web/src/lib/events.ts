import { join, t } from '../../../src/i18n.js';
import type { EventRow } from '../../../src/store/types.js';
import { formatBytes, formatTime, shortSha, type Tone } from './format.js';
import { href } from './router.js';

// The Events page: events the Master records outside any Run (restarts, pruned logs, a restored
// database, upgrades, configuration reloads, GitHub errors, failed notifications, scouts...).

type GlobalEvent = Pick<EventRow, 'type' | 'data'>;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "3 个 Run" / "3 Runs". */
function count(n: number, zh: string, one: string, many: string): string {
  return t({ zh: `${n} ${zh}`, en: `${n} ${n === 1 ? one : many}` });
}

/** 「demo」 / "demo", or a stand-in when the event does not say which repo. */
function repoOf(event: GlobalEvent): string {
  return str(event.data.repo) ?? t({ zh: '某个仓库', en: 'a repo' });
}

/** "abc1234 → def5678" when both commits are known. */
function commits(from: unknown, to: unknown): string | null {
  const a = str(from);
  const b = str(to);
  return a && b ? `${shortSha(a)} → ${shortSha(b)}` : null;
}

/** "：message" / ": message", or nothing without one. */
function withMessage(message: unknown): string {
  const m = str(message);
  return m ? t({ zh: `：${m}`, en: `: ${m}` }) : '';
}

/**
 * The global event in words, from its structured data. Missing fields fall back to a general
 * sentence. null for types it does not know: the page shows the type and the raw data instead,
 * so events added later still show.
 */
export function globalEventText(event: GlobalEvent, now = new Date()): string | null {
  const d = event.data;
  switch (event.type) {
    case 'master.restarted': {
      const pid = num(d.pid);
      const startedAt = str(d.startedAt);
      const who = [
        pid === null ? null : `pid ${pid}`,
        startedAt === null
          ? null
          : t({
              zh: `${formatTime(startedAt, now)} 启动`,
              en: `started ${formatTime(startedAt, now)}`,
            }),
      ].filter((s): s is string => s !== null);
      const prev =
        who.length > 0
          ? t({
              zh: `上一个 Master（${join(who)}）`,
              en: `The previous Master (${join(who)})`,
            })
          : t({ zh: '上一个 Master ', en: 'The previous Master' });
      return t({
        zh: `${prev}没有正常退出（崩溃、被强行结束或机器重启）；之后启动了这个 Master，没做完的 Run 接着做`,
        en: `${prev} stopped without shutting down (it crashed, was killed or the machine restarted); this Master started after it and carries on with the unfinished Runs`,
      });
    }
    case 'master.node_missing': {
      const node = str(d.node);
      const commit = str(d.commit);
      const what = node
        ? t({ zh: `Master 正在用的 node（${node}）`, en: `The node this Master ran on (${node})` })
        : t({ zh: 'Master 正在用的 node ', en: 'The node this Master ran on' });
      const on = commit
        ? t({
            zh: `在当前版本 ${shortSha(commit)} 上`,
            en: ` on the same version ${shortSha(commit)}`,
          })
        : t({ zh: '在当前版本上', en: ' on the same version' });
      return t({
        zh: `${what}不见了（比如换 Node 版本时被删掉），检查命令跑不了；找到能用的 node 后${on}重启`,
        en: `${what} was gone (deleted when switching Node versions, say), so no checks could run; restarting with a usable node${on}`,
      });
    }
    case 'master.working':
      if (d.on === true) {
        return t({
          zh: '打开了工作开关：Master 接着开始 Run、领取 issue、自动侦察',
          en: 'Work switched on: the Master starts Runs, takes issues and scouts by itself again',
        });
      }
      if (d.on === false) {
        return t({
          zh: '关闭了工作开关：Master 不再开始 Run、不领取 issue、不自动侦察，正在执行的做完为止',
          en: 'Work switched off: the Master starts no Run, takes no issue and scouts no more by itself; what is executing finishes',
        });
      }
      return null;
    case 'logs.pruned': {
      const files = num(d.files);
      const bytes = num(d.bytes);
      const runs = num(d.runs) ?? 0;
      const scouts = num(d.scouts) ?? 0;
      const what =
        files === null
          ? t({ zh: '超过保留期的原始日志', en: 'raw logs past retention' })
          : t({
              zh: ` ${files} 个超过保留期的原始日志`,
              en: `${files} raw log ${files === 1 ? 'file' : 'files'} past retention`,
            });
      const size =
        bytes === null
          ? ''
          : t({ zh: `（${formatBytes(bytes)}）`, en: ` (${formatBytes(bytes)})` });
      const from = [
        runs > 0 ? count(runs, '个 Run', 'Run', 'Runs') : null,
        scouts > 0 ? count(scouts, '次侦察', 'scout', 'scouts') : null,
      ].filter((s): s is string => s !== null);
      const of =
        from.length > 0
          ? t({ zh: `，涉及 ${join(from)}`, en: `, from ${from.join(' and ')}` })
          : '';
      // Run pages show the agent output from the kept condensed events, not from the raw logs.
      // Scouts keep no such events and their raw output was never on the dashboard, so when only
      // scouts are named, what stays is their record on the Issues page.
      const kept =
        runs === 0 && scouts > 0
          ? t({
              zh: '；「需求」页上的侦察记录不受影响',
              en: '; the scouts on the Issues page are not affected',
            })
          : t({
              zh: '；各 Run 详情页里的 Agent 输出不受影响',
              en: "; the agent output on each Run's page is not affected",
            });
      return t({
        zh: `删除了${what}${size}${of}${kept}`,
        en: `Deleted ${what}${size}${of}${kept}`,
      });
    }
    case 'store.backup_restored': {
      const backup = str(d.backup);
      const movedTo = str(d.movedTo);
      const from = num(d.fromVersion);
      const to = num(d.toVersion);
      const versions =
        from !== null && to !== null
          ? t({
              zh: `数据库版本（${from}）比 Master 支持的（${to}）更新`,
              en: `The database (version ${from}) was newer than the Master supports (version ${to})`,
            })
          : t({
              zh: '数据库版本比 Master 支持的更新',
              en: 'The database was newer than the Master supports',
            });
      const restored = backup
        ? t({
            zh: `恢复了迁移前的备份 ${backup}`,
            en: `restored the backup taken before the migration, ${backup}`,
          })
        : t({ zh: '恢复了迁移前的备份', en: 'restored the backup taken before the migration' });
      const moved = movedTo
        ? t({
            zh: `；较新的数据库移到了 ${movedTo}，以后再升级时可以从那里找回`,
            en: `; the newer database was moved to ${movedTo}, where it can be recovered after upgrading again`,
          })
        : '';
      return t({
        zh: `${versions}，多半是升级回退到了旧版本：${restored}${moved}`,
        en: `${versions}, most likely because an upgrade was rolled back: ${restored}${moved}`,
      });
    }
    case 'config.reloaded': {
      const errors = num(d.errors) ?? 0;
      if (errors > 0) {
        return t({
          zh: `重新加载了配置文件，有 ${errors} 项无效，已停用`,
          en: `Reloaded the configuration files; ${errors} ${errors === 1 ? 'item is' : 'items are'} invalid and disabled`,
        });
      }
      return t({ zh: '重新加载了配置文件', en: 'Reloaded the configuration files' });
    }
    case 'config.reload_failed':
      return t({
        zh: `配置文件有错误，重新加载失败，仍在用上一份有效配置${withMessage(d.message)}`,
        en: `The configuration files have errors and could not be reloaded; the last valid configuration stays in use${withMessage(d.message)}`,
      });
    case 'github.error':
      return t({
        zh: `访问 GitHub 出错${withMessage(d.message)}`,
        en: `GitHub request failed${withMessage(d.message)}`,
      });
    case 'notify.webhook_failed':
      return t({
        zh: `webhook 通知发送失败${withMessage(d.reason)}；之后的失败不再记录，直到有通知发送成功`,
        en: `A webhook notification could not be sent${withMessage(d.reason)}; later failures are not recorded until one gets through`,
      });
    case 'notify.system_failed': {
      const command = str(d.command);
      const via = command ? t({ zh: `（${command}）`, en: ` (${command})` }) : '';
      return t({
        zh: `系统通知发送失败${via}${withMessage(d.reason)}；之后的失败不再记录，直到有通知发送成功`,
        en: `A system notification could not be sent${via}${withMessage(d.reason)}; later failures are not recorded until one gets through`,
      });
    }
    case 'github.pushed': {
      const branch = str(d.branch);
      const head = str(d.head);
      const what = branch
        ? t({ zh: `${repoOf(event)} 的 ${branch}`, en: `${branch} of ${repoOf(event)}` })
        : t({
            zh: `${repoOf(event)} 的目标分支`,
            en: `the target branch of ${repoOf(event)}`,
          });
      const at = head ? t({ zh: `（${shortSha(head)}）`, en: ` (${shortSha(head)})` }) : '';
      return t({
        zh: `把 ${what} 推送到了 GitHub${at}`,
        en: `Pushed ${what} to GitHub${at}`,
      });
    }
    case 'issue.auto_accepted': {
      const issue = num(d.issue);
      const which = issue === null ? '' : ` #${issue}`;
      return t({
        zh: `自动采纳了 ${repoOf(event)} 的提案${which}，等着开工`,
        en: `Accepted proposal${which} of ${repoOf(event)} automatically; it waits to be worked on`,
      });
    }
    case 'scout.started':
      if (d.trigger === 'auto') {
        return t({
          zh: `自动开始侦察 ${repoOf(event)}`,
          en: `Started scouting ${repoOf(event)} by itself`,
        });
      }
      if (d.trigger === 'manual') {
        return t({
          zh: `手动开始侦察 ${repoOf(event)}`,
          en: `Started scouting ${repoOf(event)} by hand`,
        });
      }
      return t({ zh: `开始侦察 ${repoOf(event)}`, en: `Started scouting ${repoOf(event)}` });
    case 'scout.completed': {
      const created = num(d.created);
      if (created === null) {
        return t({ zh: `侦察 ${repoOf(event)} 完成`, en: `Scouting ${repoOf(event)} finished` });
      }
      if (created === 0) {
        return t({
          zh: `侦察 ${repoOf(event)} 完成，没有提出新的 issue`,
          en: `Scouting ${repoOf(event)} finished without proposing any issue`,
        });
      }
      const auto = num(d.auto) ?? 0;
      const pending = num(d.pending) ?? 0;
      const parts = [
        auto > 0 ? t({ zh: `${auto} 个自动采纳`, en: `${auto} accepted automatically` }) : null,
        pending > 0
          ? t({ zh: `${pending} 个等人采纳`, en: `${pending} waiting for a human` })
          : null,
      ].filter((s): s is string => s !== null);
      const which =
        parts.length > 0 ? t({ zh: `，其中 ${join(parts)}`, en: `: ${parts.join(' and ')}` }) : '';
      return t({
        zh: `侦察 ${repoOf(event)} 完成，提出了 ${created} 个 issue${which}`,
        en: `Scouting ${repoOf(event)} finished and proposed ${created} ${created === 1 ? 'issue' : 'issues'}${which}`,
      });
    }
    case 'scout.failed': {
      const streak = num(d.streak);
      const times =
        streak !== null && streak > 1
          ? t({ zh: `（连续第 ${streak} 次）`, en: ` (${streak} times in a row)` })
          : '';
      return t({
        zh: `侦察 ${repoOf(event)} 失败${times}${withMessage(d.message)}`,
        en: `Scouting ${repoOf(event)} failed${times}${withMessage(d.message)}`,
      });
    }
    case 'scout.rate_limited': {
      const retryAt = str(d.retryAt);
      return retryAt
        ? t({
            zh: `侦察 ${repoOf(event)} 的 Agent 额度用完或被限流，预计 ${formatTime(retryAt, now)} 恢复后再侦察`,
            en: `The agent scouting ${repoOf(event)} ran out of quota or was rate-limited; scouting again once it is back, expected at ${formatTime(retryAt, now)}`,
          })
        : t({
            zh: `侦察 ${repoOf(event)} 的 Agent 额度用完或被限流，额度恢复后再侦察`,
            en: `The agent scouting ${repoOf(event)} ran out of quota or was rate-limited; scouting again once it is back`,
          });
    }
    case 'upgrade.started': {
      if (d.reason === 'node_missing') {
        const from = str(d.from);
        return from
          ? t({
              zh: `为换上能用的 node，在当前版本 ${shortSha(from)} 上重启`,
              en: `Restarting on the same version ${shortSha(from)} to run on a usable node`,
            })
          : t({
              zh: '为换上能用的 node，在当前版本上重启',
              en: 'Restarting on the same version to run on a usable node',
            });
      }
      const range = commits(d.from, d.to);
      return range
        ? t({ zh: `开始自动升级：${range}`, en: `Upgrading: ${range}` })
        : t({ zh: '开始自动升级', en: 'Upgrading' });
    }
    case 'upgrade.done': {
      const range = commits(d.from, d.to);
      return range
        ? t({ zh: `升级完成：${range}`, en: `Upgraded: ${range}` })
        : t({ zh: '升级完成', en: 'Upgraded' });
    }
    case 'upgrade.failed': {
      const range = commits(d.from, d.to);
      const what = range
        ? t({ zh: `升级 ${range} `, en: `Upgrading ${range}` })
        : t({ zh: '升级', en: 'The upgrade' });
      const failed =
        d.env === true
          ? t({
              zh: `${what}因运行环境的问题失败（比如找不到 node 或 npm），过一阵会再试`,
              en: `${what} failed for a problem of the environment (no node or npm, say) and will be tried again later`,
            })
          : t({ zh: `${what}失败`, en: `${what} failed` });
      return `${failed}${withMessage(d.message)}`;
    }
    default:
      return null;
  }
}

/** Errors in red; things worth a look (a crash, a restored database, a lost node) in orange. */
export function globalEventTone(event: GlobalEvent): Tone {
  switch (event.type) {
    case 'github.error':
    case 'notify.webhook_failed':
    case 'notify.system_failed':
    case 'config.reload_failed':
    case 'upgrade.failed':
    case 'scout.failed':
      return 'danger';
    case 'master.restarted':
    case 'master.node_missing':
    case 'store.backup_restored':
      return 'attention';
    case 'config.reloaded':
      return (num(event.data.errors) ?? 0) > 0 ? 'attention' : 'neutral';
    default:
      return 'neutral';
  }
}

/** Where to see more about the event: scouts and the issues they propose live on the Issues page. */
export function globalEventLink(event: Pick<EventRow, 'type'>): string | null {
  if (event.type.startsWith('scout.') || event.type === 'issue.auto_accepted') return href.issues;
  return null;
}

/** Global events loaded so far, newest first, and whether the oldest one is among them. */
export interface EventPages {
  events: EventRow[];
  /** No older event is left to load. */
  complete: boolean;
}

/** Newest first, each id once. */
function merged(a: EventRow[], b: EventRow[]): EventRow[] {
  const byId = new Map<number, EventRow>();
  for (const e of [...a, ...b]) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => y.id - x.id);
}

/**
 * The newest page (re)loaded: merged into what is loaded. When so many events came meanwhile
 * that a full page no longer reaches what is loaded, the events between are unknown, so it
 * starts over from that page rather than show a gap.
 */
export function withLatest(
  pages: EventPages | null,
  latest: EventRow[],
  pageSize: number,
): EventPages {
  const full = latest.length >= pageSize;
  const newestLoaded = pages?.events[0]?.id;
  const oldestLatest = latest.at(-1)?.id;
  if (
    !pages ||
    newestLoaded === undefined ||
    (full && oldestLatest !== undefined && oldestLatest > newestLoaded)
  ) {
    return { events: latest, complete: !full };
  }
  return { events: merged(pages.events, latest), complete: pages.complete || !full };
}

/**
 * An older page, asked for with `before`, arrived. Dropped when what is loaded changed meanwhile
 * (started over), since it would no longer join on.
 */
export function withOlder(
  pages: EventPages,
  before: number,
  older: EventRow[],
  pageSize: number,
): EventPages {
  if (pages.events.at(-1)?.id !== before) return pages;
  return { events: merged(pages.events, older), complete: older.length < pageSize };
}
