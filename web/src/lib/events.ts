import { join, t } from '../../../src/i18n.js';
import { divergedCause } from '../../../src/notify/notice.js';
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

/** "1 step" / "3 steps", for the English texts. */
const steps = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

/** 「demo」 / "demo", or a stand-in when the event does not say which repo. */
function repoOf(event: GlobalEvent): string {
  return str(event.data.repo) ?? t({ zh: '某个仓库', en: 'a repo' });
}

/** 「demo 的 main」 / "main of demo", or the repo's target branch when the event names none. */
function branchOf(event: GlobalEvent): string {
  const branch = str(event.data.branch);
  return branch
    ? t({ zh: `${repoOf(event)} 的 ${branch}`, en: `${branch} of ${repoOf(event)}` })
    : t({ zh: `${repoOf(event)} 的目标分支`, en: `the target branch of ${repoOf(event)}` });
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
      const head = str(d.head);
      const at = head ? t({ zh: `（${shortSha(head)}）`, en: ` (${shortSha(head)})` }) : '';
      return t({
        zh: `把 ${branchOf(event)} 推送到了 GitHub${at}`,
        en: `Pushed ${branchOf(event)} to GitHub${at}`,
      });
    }
    case 'github.pulled': {
      const range = commits(d.from, d.to);
      const at = range ? t({ zh: `（${range}）`, en: ` (${range})` }) : '';
      return t({
        zh: `从 GitHub 拉取了新提交，${branchOf(event)} 快进了过去${at}；之后的 Run 以它为基础`,
        en: `Pulled new commits from GitHub and fast-forwarded ${branchOf(event)} to them${at}; later Runs build on them`,
      });
    }
    case 'github.diverged': {
      const local = str(d.local);
      const remote = str(d.remote);
      const at =
        local && remote
          ? t({
              zh: `（本地 ${shortSha(local)}，GitHub ${shortSha(remote)}）`,
              en: ` (local ${shortSha(local)}, GitHub ${shortSha(remote)})`,
            })
          : '';
      const cause = divergedCause(d);
      const runId = str(d.runId);
      if (runId) {
        // Handed to a Run the Master created to merge GitHub's commit: nothing for a human yet.
        return t({
          zh: `${branchOf(event)} 和 GitHub 上的已经分叉${at}，${cause?.text ?? '两边各有对方没有的提交'}；已交给 Run ${runId} 处理，不用你手动合并：编码 Agent 合并两边，评审并合并后推送；在此之前不推送，已完成 Run 的 issue 保持打开`,
          en: `Diverged from GitHub: ${branchOf(event)}${at} and the one on GitHub each have commits the other lacks${cause ? `, and ${cause.text}` : ''}. Run ${runId} takes it over, with nothing to merge by hand: its coding agent merges the two, pushed once the Run is reviewed and merged; until then nothing is pushed and the issues of completed Runs stay open`,
        });
      }
      if (cause?.kind === 'environment') {
        return t({
          zh: `${branchOf(event)} 和 GitHub 上的已经分叉${at}，${cause.text}；装好后下一轮检查会自动再合并，在此之前不推送，已完成 Run 的 issue 保持打开`,
          en: `Diverged from GitHub: ${branchOf(event)}${at} and the one on GitHub each have commits the other lacks, and ${cause.text}. Once it is installed, the next check merges by itself; until then nothing is pushed and the issues of completed Runs stay open`,
        });
      }
      if (cause) {
        return t({
          zh: `${branchOf(event)} 和 GitHub 上的已经分叉${at}，${cause.text}，要你手动合并；在此之前不推送，已完成 Run 的 issue 保持打开`,
          en: `Diverged from GitHub: ${branchOf(event)}${at} and the one on GitHub each have commits the other lacks, and ${cause.text}. Merge them by hand; until then nothing is pushed and the issues of completed Runs stay open`,
        });
      }
      return t({
        zh: `${branchOf(event)} 和 GitHub 上的已经分叉${at}，两边各有对方没有的提交，不会自动合并，要你手动合并；在此之前不推送，已完成 Run 的 issue 保持打开`,
        en: `Diverged from GitHub: ${branchOf(event)}${at} and the one on GitHub each have commits the other lacks, and they are not merged by themselves. Merge them by hand; until then nothing is pushed and the issues of completed Runs stay open`,
      });
    }
    case 'github.diverged_run': {
      const runId = str(d.runId);
      const local = str(d.local);
      const remote = str(d.remote);
      const at =
        local && remote
          ? t({
              zh: `（本地 ${shortSha(local)}，GitHub ${shortSha(remote)}）`,
              en: ` (local ${shortSha(local)}, GitHub ${shortSha(remote)})`,
            })
          : '';
      const run = runId
        ? t({ zh: ` Run ${runId}`, en: `Run ${runId}` })
        : t({ zh: '一个 Run', en: 'a Run' });
      const commit = remote
        ? t({
            zh: `GitHub 上的提交 ${shortSha(remote)}`,
            en: `commit ${shortSha(remote)} from GitHub`,
          })
        : t({ zh: 'GitHub 上的新提交', en: 'the new commits from GitHub' });
      return t({
        zh: `${branchOf(event)} 和 GitHub 上的分叉了${at}，Master 自己没能合并，建了${run}：由编码 Agent 合并 ${commit}，评审并合并后推送到 GitHub`,
        en: `Diverged from GitHub: the Master could not merge ${branchOf(event)}${at} by itself, so it created ${run}, whose coding agent merges ${commit}; pushed to GitHub once the Run is reviewed and merged`,
      });
    }
    case 'github.merged_remote': {
      const merge = str(d.merge);
      const local = str(d.local);
      const remote = str(d.remote);
      const at =
        merge && local && remote
          ? t({
              zh: `（本地 ${shortSha(local)} 和 GitHub ${shortSha(remote)} → ${shortSha(merge)}）`,
              en: ` (local ${shortSha(local)} and GitHub ${shortSha(remote)} → ${shortSha(merge)})`,
            })
          : '';
      return t({
        zh: `${branchOf(event)} 和 GitHub 上的分叉了，Master 自己合并了 GitHub 上的新提交，仓库的检查通过后把分支快进到合并提交${at}，随后推送到 GitHub`,
        en: `${branchOf(event)} had diverged from GitHub: the Master merged the new commits from GitHub, and with the repo's checks passing, fast-forwarded the branch to the merge${at}, to be pushed to GitHub`,
      });
    }
    case 'github.pull_blocked': {
      const worktree = str(d.worktree);
      const where = worktree ? t({ zh: `在 ${worktree} `, en: ` in ${worktree}` }) : '';
      return t({
        zh: `GitHub 上有新提交，但 ${branchOf(event)} 检出${where}有未提交的改动，没能快进；提交或丢弃这些改动后，下一轮检查会自动拉取`,
        en: `GitHub has new commits, but ${branchOf(event)} is checked out${where} with uncommitted changes and could not be fast-forwarded; once they are committed or discarded, the next check pulls by itself`,
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
    case 'iteration.auto_accepted':
    case 'iteration.accepted': {
      const issue = num(d.issue);
      const which = issue === null ? '' : ` #${issue}`;
      // An iteration of the local backlog: its steps are proposals, not issues.
      if (d.backlog === true) {
        return event.type === 'iteration.auto_accepted'
          ? t({
              zh: `整批自动采纳了 ${repoOf(event)} 的一个本地迭代，子项按依赖顺序开工`,
              en: `Accepted a local iteration of ${repoOf(event)} automatically as a whole; its steps start in the order of their dependencies`,
            })
          : t({
              zh: `${repoOf(event)} 的一个本地迭代已整批采纳，子项按依赖顺序开工`,
              en: `A local iteration of ${repoOf(event)} was accepted as a whole; its steps start in the order of their dependencies`,
            });
      }
      return event.type === 'iteration.auto_accepted'
        ? t({
            zh: `整批自动采纳了 ${repoOf(event)} 的迭代${which}，子 issue 按依赖顺序开工`,
            en: `Accepted iteration${which} of ${repoOf(event)} automatically as a whole; its sub-issues start in the order of their dependencies`,
          })
        : t({
            zh: `${repoOf(event)} 的迭代${which} 已整批采纳，子 issue 按依赖顺序开工`,
            en: `Iteration${which} of ${repoOf(event)} was accepted as a whole; its sub-issues start in the order of their dependencies`,
          });
    }
    case 'iteration.child_status': {
      const issue = num(d.issue);
      const position = num(d.position);
      const child = num(d.child);
      const iteration = t({
        zh: `${repoOf(event)} 的迭代${issue === null ? '' : ` #${issue}`}`,
        en: `Iteration${issue === null ? '' : ` #${issue}`} of ${repoOf(event)}`,
      });
      const step =
        position === null
          ? t({ zh: '一步', en: 'a step' })
          : t({
              zh: `第 ${position} 步${child === null ? '' : `（#${child}）`}`,
              en: `step ${position}${child === null ? '' : ` (#${child})`}`,
            });
      const what = t<Record<string, string>>({
        zh: {
          waiting: '在等它依赖的步骤完成',
          ready: '可以开工了',
          running: '开工了',
          done: '完成了',
          failed: '失败了',
          dropped: '不做了',
        },
        en: {
          waiting: 'waits for the steps it depends on',
          ready: 'can start',
          running: 'started',
          done: 'is done',
          failed: 'failed',
          dropped: 'was dropped',
        },
      })[str(d.status) ?? ''];
      const changed = what ?? t({ zh: '状态变了', en: 'changed' });
      return t({ zh: `${iteration}：${step}${changed}`, en: `${iteration}: ${step} ${changed}` });
    }
    case 'iteration.blocked': {
      const issue = num(d.issue);
      const position = num(d.position);
      const child = num(d.child);
      const step =
        position === null
          ? t({ zh: '一步', en: 'a step' })
          : t({
              zh: `第 ${position} 步${child === null ? '' : `（#${child}）`}`,
              en: `step ${position}${child === null ? '' : ` (#${child})`}`,
            });
      // A step of the local backlog fails once its Runs used up their attempts, and also when a
      // human terminated its Run or its assessment dropped it.
      const why =
        d.reason === 'failed' && d.backlog === true
          ? t({
              zh: '没有做成（Run 用完重做次数后仍然失败、被终止，或需求评估结论为不做）',
              en: 'was not done (its Runs failed until its attempts were used up, its Run was terminated, or its assessment dropped it)',
            })
          : d.reason === 'failed'
            ? t({ zh: '用完重做次数后失败了', en: 'failed after using up its attempts' })
            : d.reason === 'dropped'
              ? t({ zh: '被人关成了不做', en: 'was closed as not planned' })
              : t({ zh: '没有做成', en: 'was not done' });
      return t({
        zh: `${repoOf(event)} 的迭代${issue === null ? '' : ` #${issue} `}受阻：${step}${why}，依赖它的步骤开不了工；侦察下次会换个做法替换它`,
        en: `Iteration${issue === null ? '' : ` #${issue}`} of ${repoOf(event)} is blocked: ${step} ${why}, so the steps depending on it cannot start; the next scout replaces it with another approach`,
      });
    }
    case 'iteration.unblocked': {
      const issue = num(d.issue);
      return t({
        zh: `${repoOf(event)} 的迭代${issue === null ? '' : ` #${issue} `}不再受阻，接着按依赖开工`,
        en: `Iteration${issue === null ? '' : ` #${issue}`} of ${repoOf(event)} is no longer blocked and goes on in the order of its dependencies`,
      });
    }
    case 'iteration.cancelled': {
      const issue = num(d.issue);
      const dropped = Array.isArray(d.dropped) ? d.dropped.length : null;
      // An iteration of the local backlog: rejected before it was accepted, cancelled after.
      if (d.backlog === true) {
        if (d.pending === true) {
          const reason = str(d.reason);
          const rejected = t({
            zh: `拒绝了 ${repoOf(event)} 的一个本地迭代，它的子项随之拒绝`,
            en: `Rejected a local iteration of ${repoOf(event)}, its steps with it`,
          });
          return reason
            ? t({
                zh: `${rejected}，理由：${reason}；之后的侦察会看到这条理由`,
                en: `${rejected}, because: ${reason}; later scouts are shown the reason`,
              })
            : rejected;
        }
        const stopped =
          dropped === null || dropped === 0
            ? ''
            : t({
                zh: `，${dropped} 个没完成的子项随之不做`,
                en: `; its ${steps(dropped)} not done ${dropped === 1 ? 'was' : 'were'} dropped with it`,
              });
        return t({
          zh: `${repoOf(event)} 的一个本地迭代被人在看板上终止了${stopped}`,
          en: `A local iteration of ${repoOf(event)} was cancelled on the dashboard${stopped}`,
        });
      }
      const which = issue === null ? '' : ` #${issue}`;
      // A space between the number and the Chinese after it.
      const zhWhich = issue === null ? '' : ` #${issue} `;
      const iteration =
        d.pending === true
          ? t({
              zh: `${repoOf(event)} 等采纳的迭代${zhWhich}`,
              en: `Iteration${which} of ${repoOf(event)}, waiting to be accepted,`,
            })
          : t({
              zh: `${repoOf(event)} 的迭代${zhWhich}`,
              en: `Iteration${which} of ${repoOf(event)}`,
            });
      const closed =
        dropped === null || dropped === 0
          ? ''
          : t({
              zh: `，${dropped} 个没完成的子项随之关成不做`,
              en: `; its ${steps(dropped)} not done ${dropped === 1 ? 'was' : 'were'} closed as not planned with it`,
            });
      return t({
        zh: `${iteration}被人关掉了${closed}`,
        en: `${iteration} was closed by a human${closed}`,
      });
    }
    case 'iteration.adjusted': {
      const issue = num(d.issue);
      const added = Array.isArray(d.added) ? d.added.length : 0;
      const replaced = Array.isArray(d.replaced) ? d.replaced.length : 0;
      const leftOut = num(d.leftOut) ?? 0;
      const parts: string[] = [];
      if (added > 0) {
        parts.push(
          replaced > 0
            ? t({
                zh: `补上 ${added} 步，其中 ${replaced} 步替换没做成的步骤`,
                en: `${steps(added)} added, ${replaced} of them replacing ${replaced === 1 ? 'a step that was' : 'steps that were'} not done`,
              })
            : t({ zh: `补上 ${added} 步`, en: `${steps(added)} added` }),
        );
      }
      if (leftOut > 0) {
        parts.push(t({ zh: `${leftOut} 步没能加上`, en: `${steps(leftOut)} left out` }));
      }
      const what =
        parts.length > 0 ? t({ zh: `：${parts.join('，')}`, en: `: ${parts.join('; ')}` }) : '';
      return t({
        zh: `侦察调整了 ${repoOf(event)} 的迭代${issue === null ? '' : ` #${issue} `}的计划${what}`,
        en: `A scout changed the plan of ${issue === null ? 'an iteration' : `iteration #${issue}`} of ${repoOf(event)}${what}`,
      });
    }
    case 'iteration.completed': {
      const issue = num(d.issue);
      const runs = num(d.runs);
      const cost = num(d.costUsd);
      const used =
        runs === null
          ? ''
          : t({
              zh: `：用了 ${runs} 个 Run${cost === null ? '' : `，共 $${cost.toFixed(2)}`}`,
              en: `: ${runs} ${runs === 1 ? 'Run' : 'Runs'}${cost === null ? '' : `, $${cost.toFixed(2)} in all`}`,
            });
      return issue === null
        ? t({
            zh: `${repoOf(event)} 的迭代全部完成${used}`,
            en: `An iteration of ${repoOf(event)} is done${used}`,
          })
        : t({
            zh: `${repoOf(event)} 的迭代 #${issue} 全部完成${used}；总结发在了迭代 issue 上`,
            en: `Iteration #${issue} of ${repoOf(event)} is done${used}; its summary is posted on the iteration issue`,
          });
    }
    case 'proposal.auto_accepted':
    case 'proposal.accepted': {
      const runId = str(d.runId);
      const auto = event.type === 'proposal.auto_accepted';
      const accepted = auto
        ? t({
            zh: `自动采纳了 ${repoOf(event)} 的一条本地提案`,
            en: `Accepted a local proposal of ${repoOf(event)} automatically`,
          })
        : t({
            zh: `采纳了 ${repoOf(event)} 的一条本地提案`,
            en: `Accepted a local proposal of ${repoOf(event)}`,
          });
      return runId
        ? t({
            zh: `${accepted}，用它的正文建了 Run ${runId}`,
            en: `${accepted} and created Run ${runId} from its text`,
          })
        : t({
            zh: `${accepted}，用它的正文建了 Run`,
            en: `${accepted} and created a Run from its text`,
          });
    }
    case 'proposal.redo_scheduled': {
      const runId = str(d.runId);
      const attempt = num(d.attempt);
      const max = num(d.maxAttempts);
      const redoAt = str(d.redoAt);
      const failed = runId
        ? t({
            zh: `${repoOf(event)} 一条本地提案的 Run ${runId} 失败了`,
            en: `Run ${runId} of a local proposal of ${repoOf(event)} failed`,
          })
        : t({
            zh: `${repoOf(event)} 一条本地提案的 Run 失败了`,
            en: `The Run of a local proposal of ${repoOf(event)} failed`,
          });
      const which =
        attempt === null
          ? ''
          : t({
              zh: `，开始第 ${attempt}${max === null ? '' : `/${max}`} 次尝试`,
              en: `, as attempt ${attempt}${max === null ? '' : ` of ${max}`}`,
            });
      return redoAt
        ? t({
            zh: `${failed}，预计 ${formatTime(redoAt)} 带着失败原因自动重做${which}`,
            en: `${failed}; it is redone automatically with the reason at ${formatTime(redoAt)}${which}`,
          })
        : t({
            zh: `${failed}，之后带着失败原因自动重做${which}`,
            en: `${failed}; it is redone automatically with the reason later${which}`,
          });
    }
    case 'proposal.redone': {
      const runId = str(d.runId);
      const attempt = num(d.attempt);
      const max = num(d.maxAttempts);
      const which =
        attempt === null
          ? ''
          : t({
              zh: `（第 ${attempt}${max === null ? '' : `/${max}`} 次尝试）`,
              en: ` (attempt ${attempt}${max === null ? '' : ` of ${max}`})`,
            });
      return runId
        ? t({
            zh: `自动重做了 ${repoOf(event)} 一条失败的本地提案：Run ${runId}${which}，带着之前每次失败的原因`,
            en: `Redid a failed local proposal of ${repoOf(event)} automatically: Run ${runId}${which}, told why each earlier attempt failed`,
          })
        : t({
            zh: `自动重做了 ${repoOf(event)} 一条失败的本地提案${which}`,
            en: `Redid a failed local proposal of ${repoOf(event)} automatically${which}`,
          });
    }
    case 'proposal.failed': {
      const n = num(d.attempts);
      const failed =
        n === null
          ? t({
              zh: `${repoOf(event)} 的一条本地提案用完了尝试次数（max_run_attempts）`,
              en: `A local proposal of ${repoOf(event)} used up its attempts (max_run_attempts)`,
            })
          : t({
              zh: `${repoOf(event)} 的一条本地提案失败 ${n} 次，达到尝试次数上限（max_run_attempts）`,
              en: `A local proposal of ${repoOf(event)} failed ${n === 1 ? 'once' : `${n} times`}, all the attempts it gets (max_run_attempts)`,
            });
      return t({
        zh: `${failed}，不再自动重做；之后的侦察会看到每次失败的原因`,
        en: `${failed}, and is not redone any more; later scouts are shown why each attempt failed`,
      });
    }
    case 'proposal.rejected': {
      const rejected = t({
        zh: `拒绝了 ${repoOf(event)} 的一条本地提案`,
        en: `Rejected a local proposal of ${repoOf(event)}`,
      });
      const reason = str(d.reason);
      return reason
        ? t({
            zh: `${rejected}，理由：${reason}；之后的侦察会看到这条理由`,
            en: `${rejected} because: ${reason}; later scouts are shown the reason`,
          })
        : t({
            zh: `${rejected}；之后的侦察会看到它和拒绝的理由`,
            en: `${rejected}; later scouts are shown it with the reason`,
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
      // A repo of the local backlog gets proposals kept by the Master instead of issues.
      const local = d.backlog === true;
      if (created === 0) {
        return local
          ? t({
              zh: `侦察 ${repoOf(event)} 完成，没有提出新的本地提案`,
              en: `Scouting ${repoOf(event)} finished without proposing anything for the local backlog`,
            })
          : t({
              zh: `侦察 ${repoOf(event)} 完成，没有提出新的 issue`,
              en: `Scouting ${repoOf(event)} finished without proposing any issue`,
            });
      }
      const auto = num(d.auto) ?? 0;
      const pending = num(d.pending) ?? 0;
      const parts = [
        auto > 0
          ? t({
              zh: local ? `${auto} 条自动采纳` : `${auto} 个自动采纳`,
              en: `${auto} accepted automatically`,
            })
          : null,
        pending > 0
          ? t({
              zh: local ? `${pending} 条等人采纳或拒绝` : `${pending} 个等人采纳`,
              en: `${pending} waiting for a human`,
            })
          : null,
      ].filter((s): s is string => s !== null);
      const which =
        parts.length > 0 ? t({ zh: `，其中 ${join(parts)}`, en: `: ${parts.join(' and ')}` }) : '';
      return local
        ? t({
            zh: `侦察 ${repoOf(event)} 完成，写入了 ${created} 条本地提案${which}`,
            en: `Scouting ${repoOf(event)} finished with ${created} ${created === 1 ? 'proposal' : 'proposals'} for the local backlog${which}`,
          })
        : t({
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
    case 'scout.update_dropped': {
      // In the Master's language, as it found them.
      const problems = Array.isArray(d.problems)
        ? d.problems.map(str).filter((p): p is string => p !== null)
        : [];
      const why =
        problems.length > 0
          ? t({ zh: `：${problems.join('；')}`, en: `: ${problems.join('; ')}` })
          : '';
      return t({
        zh: `侦察 ${repoOf(event)} 时提出的计划调整不符合进行中迭代的计划，丢掉了这份调整，其余结果照常采用${why}`,
        en: `Scouting ${repoOf(event)} gave a change that does not fit the plan of the iteration under way; the change was dropped and the rest of the result taken as usual${why}`,
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
    // A local proposal given up after its Runs failed: no attempt left, nothing goes on by itself.
    case 'proposal.failed':
      return 'danger';
    case 'master.restarted':
    case 'master.node_missing':
    case 'store.backup_restored':
    case 'github.diverged':
    case 'github.pull_blocked':
    case 'iteration.blocked':
    // The plan stays as it was: a blocked iteration waits for the next scout to change it.
    case 'scout.update_dropped':
      return 'attention';
    case 'config.reloaded':
      return (num(event.data.errors) ?? 0) > 0 ? 'attention' : 'neutral';
    case 'github.diverged_run':
      // A Run took the merge over; the github.diverged recorded with it is the one to look at.
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** A link from an event to where to see more about it. */
export interface EventLink {
  href: string;
  label: string;
}

/**
 * Where to see more about the event: an iteration on its own page; scouts, the issues they propose
 * and the local proposals on the Issues page (a failed one with every reason, one waiting to be
 * redone with when); a divergence handed to a Run, and an accepted or redone local proposal, on
 * that Run's page.
 */
export function globalEventLink(event: GlobalEvent): EventLink | null {
  const iterationId = str(event.data.iterationId);
  if (event.type.startsWith('iteration.') && iterationId) {
    return {
      href: href.iteration(iterationId),
      label: t({ zh: '查看迭代', en: 'See the iteration' }),
    };
  }
  const runId = str(event.data.runId);
  const toRun =
    event.type === 'github.diverged' ||
    event.type === 'github.diverged_run' ||
    event.type === 'proposal.accepted' ||
    event.type === 'proposal.auto_accepted' ||
    event.type === 'proposal.redone';
  if (toRun && runId) {
    return { href: href.run(runId), label: t({ zh: '查看 Run', en: 'See the Run' }) };
  }
  if (
    event.type.startsWith('scout.') ||
    event.type.startsWith('proposal.') ||
    event.type.startsWith('iteration.') ||
    event.type === 'issue.auto_accepted'
  ) {
    return { href: href.issues, label: t({ zh: '查看需求', en: 'See issues' }) };
  }
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
