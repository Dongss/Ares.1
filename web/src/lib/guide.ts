import type {
  ConfigView,
  GitHubRepoStatus,
  NotifyTestResult,
  UpgradeStatus,
} from '../../../src/api/types.js';
import {
  type AutoAcceptRule,
  backoffMs,
  budgetPauses,
  effectiveBudget,
  issueRunOverrides,
  MAX_SCOUT_BACKOFF_HOURS,
  RATE_LIMIT_WAIT,
  RAW_LOG_KEEP_DAYS,
  REDO_BACKOFF_MAX_HOURS,
  REPO_WORKFLOWS_DIR,
  redoDelayMs,
  type TemplateSource,
} from '../../../src/config/flow.js';
import { waitText } from '../../../src/engine/discussion.js';
import { join, t } from '../../../src/i18n.js';
import { NOTICE_KINDS, type NoticeKind } from '../../../src/notify/notice.js';
import { findRepoTemplate } from './config.js';
import { buildFlow, type FlowStage } from './flow.js';
import { formatCost, formatMinutes, type Tone } from './format.js';
import { acceptRanges, afterChinese, beforeChinese, scoutWaitText } from './issues.js';
import { webhookNote } from './notify.js';

// The guide page: how the self-hosting loop works under the current configuration.
// Every sentence that depends on the configuration is worded here, from the API's views, so the
// page follows config.yaml as it is reloaded. Pure logic only; the page is pages/Guide.tsx.

/** Who does a step: an AI agent, the Master by itself (deterministic), or you. */
export type Actor = 'ai' | 'master' | 'human';

/** Labels are getters: they are worded in the language in use when read. */
export const ACTOR: Readonly<Record<Actor, { readonly label: string; readonly tone: Tone }>> = {
  ai: { label: 'AI', tone: 'active' },
  master: {
    get label() {
      return t({ zh: 'Master 自动', en: 'Master (auto)' });
    },
    tone: 'success',
  },
  human: {
    get label() {
      return t({ zh: '由你来做', en: 'Up to you' });
    },
    tone: 'attention',
  },
};

/** Sections of the guide, in page order; `#/guide/<id>` scrolls to one. Titles are getters. */
export const GUIDE_SECTIONS = [
  {
    id: 'intro',
    get title() {
      return t({ zh: '这是什么', en: 'What this is' });
    },
  },
  {
    id: 'cycle',
    get title() {
      return t({ zh: '整体循环', en: 'The loop' });
    },
  },
  {
    id: 'scout',
    get title() {
      return t({ zh: '什么时候会自己找活', en: 'When it finds work by itself' });
    },
  },
  {
    id: 'you',
    get title() {
      return t({ zh: '你要做的事', en: 'What you do' });
    },
  },
  {
    id: 'notify',
    get title() {
      return t({ zh: '会在什么时候通知你', en: 'When you are notified' });
    },
  },
  {
    id: 'labels',
    get title() {
      return t({ zh: '标签的含义', en: 'What the labels mean' });
    },
  },
  {
    id: 'guards',
    get title() {
      return t({ zh: '护栏', en: 'Guardrails' });
    },
  },
  {
    id: 'faq',
    get title() {
      return t({ zh: '常见问题', en: 'FAQ' });
    },
  },
] as const;

export type GuideSection = (typeof GUIDE_SECTIONS)[number]['id'];

export function isGuideSection(id: string): id is GuideSection {
  return GUIDE_SECTIONS.some((s) => s.id === id);
}

/** What the guide is about: one repo of the `github` section, as configured now. */
export interface GuideInput {
  /** The repo whose issues the Master works on; null when GitHub is not set up (or has no repo). */
  github: GitHubRepoStatus | null;
  /** `github.poll_minutes`. */
  pollMinutes: number;
  /** `concurrency.per_repo`: how many Runs of a repo execute at the same time. */
  perRepo: number;
  /** The Runs created from its issues (`issueFlow`); null without GitHub or a valid template. */
  flow: IssueFlow | null;
  /** The registered repo's target branch; null when not known. */
  targetBranch: string | null;
  upgrade: Pick<UpgradeStatus, 'auto' | 'installDir'>;
}

/** How a Run created from an issue goes: the template with the `auto_merge` override applied. */
export interface IssueFlow {
  templateName: string;
  /** Where the template comes from: the home directory, or the repo's own .ares1/workflows/. */
  templateSource: TemplateSource;
  stages: FlowStage[];
  /** The Run's budget in USD; undefined = no limit. */
  budgetUsd: number | undefined;
  /** Whether a Run over its budget waits for you to raise it, rather than ending as failed. */
  budgetPauses: boolean;
}

/**
 * The flow of the Runs a repo's issues become, as the Master creates them: the same template (the
 * home directory's, else the repo's own, `findRepoTemplate`) and the same overrides
 * (`issueRunOverrides`). null when the template is missing or invalid.
 */
export function issueFlow(
  config: Pick<ConfigView, 'templates' | 'repoTemplates' | 'agents'>,
  github: Pick<GitHubRepoStatus, 'name' | 'template' | 'autoMerge'>,
  repoVerifyCommands: string[] | null,
): IssueFlow | null {
  const found = findRepoTemplate(config, github.name, github.template);
  if (!found) return null;
  const { template } = found;
  const overrides = issueRunOverrides(template, github.autoMerge) ?? {};
  return {
    templateName: template.name ?? template.id,
    templateSource: found.source,
    stages: buildFlow({ template, overrides, repoVerifyCommands, agents: config.agents }),
    budgetUsd: effectiveBudget(template, overrides),
    budgetPauses: budgetPauses(template, overrides),
  };
}

// ---- the cycle ---------------------------------------------------------------

export type CycleStepId = 'scout' | 'propose' | 'accept' | 'run' | 'push' | 'upgrade' | 'rescout';

export interface CycleStep {
  id: CycleStepId;
  name: string;
  /** Who does it, the main one first. */
  actors: Actor[];
  text: string;
}

/** A stage of the Run step. */
export interface CycleStage {
  id: string;
  name: string;
  /** Empty for placeholder stages: nobody does anything yet. */
  actors: Actor[];
  note: string;
}

/** Whether the merge of a Run from an issue waits for an approval. */
export function mergeNeedsApproval(input: Pick<GuideInput, 'github' | 'flow'>): boolean {
  if (input.flow) return input.flow.stages.some((s) => s.kind === 'merge' && s.gate);
  return !input.github?.autoMerge;
}

function canUpgradeItself(upgrade: GuideInput['upgrade']): boolean {
  return upgrade.auto && upgrade.installDir !== null;
}

/**
 * The accept step: which proposals the Master accepts by itself and which are left to you, by the
 * auto-accept rule (`rule`; tests may pass another). Only marked "up to you" when some are.
 */
export function acceptStep(github: GitHubRepoStatus | null, rule?: AutoAcceptRule): CycleStep {
  const id = 'accept';
  const name = t({ zh: '采纳', en: 'Accept' });
  if (!github) {
    return {
      id,
      name,
      actors: ['human'],
      text: t({
        zh: '由你来做：接入 GitHub 后，给要做的 issue 加 ares1:ready',
        en: 'Up to you: once GitHub is set up, label the issues to do with ares1:ready',
      }),
    };
  }
  const { auto, human } = acceptRanges(github.autoAccept, rule);
  if (auto === null) {
    // Nothing is accepted automatically, so every proposal is left to you.
    const all = human ?? '';
    return {
      id,
      name,
      actors: ['human'],
      text: t({
        zh: `${all}都由你来做：给要做的 issue 加 ares1:ready；不做的关闭为 not planned 并写一句理由`,
        en: `${capitalize(all)} are up to you: label the issues to do with ares1:ready; close the others as not planned with a one-line reason`,
      }),
    };
  }
  const { maxPerDay } = github.autoAccept;
  const { dailyUsd } = github.budget;
  // Both limits only pause it for the day: the next day the Master accepts the backlog itself.
  const limits = [
    maxPerDay !== null
      ? t({
          zh: `自动采纳满 ${maxPerDay} 条`,
          en: `${maxPerDay} ${maxPerDay === 1 ? 'proposal is' : 'proposals are'} accepted`,
        })
      : null,
    dailyUsd !== null
      ? t({
          zh: `自动花费到 ${formatCost(dailyUsd)}`,
          en: `automatic spending reaches ${formatCost(dailyUsd)}`,
        })
      : null,
  ].filter((l) => l !== null);
  const pause =
    limits.length > 0
      ? t({
          zh: `；当天${beforeChinese(limits.join('或'))}后暂停，第二天自动继续采纳积压的提案`,
          en: `; once ${limits.join(' or ')} in a day, it pauses for the rest of the day and accepts the backlog by itself the next day`,
        })
      : '';
  const accepted = t({
    zh: `${auto}自动采纳（加 ares1:ready 和 ares1:auto）${pause}`,
    en: `Accepted automatically: ${auto} (labeled ares1:ready and ares1:auto)${pause}`,
  });
  if (human === null) return { id, name, actors: ['master'], text: accepted };
  return {
    id,
    name,
    actors: ['master', 'human'],
    text: t({
      zh: `${accepted}；${human}由你来做：加 ares1:ready 或关闭`,
      en: `${accepted}. Up to you: ${human}; add ares1:ready or close them`,
    }),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How many Runs execute at the same time under `concurrency.per_repo`, lowercase. */
export function concurrencyText(perRepo: number): string {
  return perRepo === 1
    ? t({
        zh: '每个仓库同一时间只执行一个 Run（concurrency.per_repo: 1），不同仓库的 Run 可以同时执行',
        en: 'each repo executes one Run at a time (concurrency.per_repo: 1), while Runs of different repos can execute side by side',
      })
    : t({
        zh: `每个仓库同一时间最多执行 ${perRepo} 个 Run（concurrency.per_repo），各在自己的工作目录里做，合并时一个一个来；不同仓库的 Run 也可以同时执行`,
        en: `each repo executes up to ${perRepo} Runs at a time (concurrency.per_repo), each in its own working directory, and they merge one at a time; Runs of different repos can execute side by side too`,
      });
}

/**
 * The steps of the loop: scout → file issues → accept → Run → push → upgrade → scout again,
 * each with who does it under the current configuration. Steps the configuration leaves to a
 * human say so ("up to you"). `rule` is the auto-accept rule; tests may pass another.
 */
export function cycleSteps(input: GuideInput, rule?: AutoAcceptRule): CycleStep[] {
  const { github, pollMinutes } = input;
  const scout = github?.scout ?? null;
  const step = (id: CycleStepId, name: string, actors: Actor[], text: string): CycleStep => ({
    id,
    name,
    actors,
    text,
  });
  const scoutName = t({ zh: '侦察', en: 'Scout' });
  const proposeName = t({ zh: '提 issue', en: 'File issues' });
  const pushName = t({ zh: '推送到 GitHub', en: 'Push to GitHub' });
  const upgradeName = t({ zh: 'Master 升级自己', en: 'Master upgrades itself' });
  const rescoutName = t({ zh: '空闲时再侦察', en: 'Scout again when idle' });

  const scoutStep = !github
    ? step(
        'scout',
        scoutName,
        ['human'],
        t({
          zh: '还没有接入 GitHub，没有 AI 侦察：做什么由你决定',
          en: 'GitHub is not set up yet, so there is no AI scout: you decide what to do',
        }),
      )
    : !scout
      ? step(
          'scout',
          scoutName,
          ['human'],
          t({
            zh: '这个仓库没有配置侦察（scout）：做什么由你决定',
            en: 'This repo has no scout configured: you decide what to do',
          }),
        )
      : step(
          'scout',
          scoutName,
          ['ai'],
          t({
            zh: `${scout.agent} 只读地看代码、文档和最近的 Run 记录，找值得做的事${
              scout.auto ? '' : '；只在你点「让 AI 找活」时进行'
            }`,
            en: `${scout.agent} reads the code, the docs and recent Runs (read-only) and looks for work worth doing${
              scout.auto ? '' : '; only when you click "Let the AI find work"'
            }`,
          }),
        );

  const propose = !github
    ? step(
        'propose',
        proposeName,
        ['human'],
        t({
          zh: '还没有接入 GitHub，提不了需求：需求只从 GitHub issue 来，先在 config.yaml 里配置 github',
          en: 'GitHub is not set up yet, so nothing can be requested: requirements only come from GitHub issues. Configure github in config.yaml first',
        }),
      )
    : !scout
      ? step(
          'propose',
          proposeName,
          ['human'],
          t({ zh: '你在 GitHub 上写 issue', en: 'You write issues on GitHub' }),
        )
      : step(
          'propose',
          proposeName,
          ['ai'],
          t({
            zh: `每条提案建一个带 ares1:proposal 的 issue，写明为什么、证据、风险和大小；一次最多 ${scout.maxProposals} 条`,
            en: `Each proposal becomes an issue labeled ares1:proposal, with the reason, evidence, risk and size; at most ${scout.maxProposals} at a time`,
          }),
        );

  const accept = acceptStep(github, rule);

  const stages = runStages(input);
  const runActors: Actor[] = ['ai', 'master'];
  if (stages ? stages.some((s) => s.actors.includes('human')) : mergeNeedsApproval(input)) {
    runActors.push('human');
  }
  const run = !github
    ? step(
        'run',
        'Run',
        runActors,
        t({
          zh: '还没有接入 GitHub，建不了 Run：Run 只从带 ares1:ready 的 issue 来',
          en: 'GitHub is not set up yet, so no Run can be created: Runs only come from issues labeled ares1:ready',
        }),
      )
    : step(
        'run',
        'Run',
        runActors,
        input.flow
          ? t({
              zh: `Master 每 ${pollMinutes} 分钟查一次带 ares1:ready 的 issue，按模板「${input.flow.templateName}」${input.flow.templateSource === 'repo' ? `（仓库自带的，在目标分支的 ${REPO_WORKFLOWS_DIR}/ 里）` : ''}建 Run，进展回写到 issue；${concurrencyText(input.perRepo)}`,
              en: `Every ${pollMinutes} minutes the Master looks for issues labeled ares1:ready, creates Runs from them with the template "${input.flow.templateName}"${input.flow.templateSource === 'repo' ? ` (the repo's own, in ${REPO_WORKFLOWS_DIR}/ on the target branch)` : ''} and reports progress on the issue; ${concurrencyText(input.perRepo)}`,
            })
          : t({
              zh: `模板「${github.template}」不存在或无效，issue 建不了 Run：先修好配置`,
              en: `The template "${github.template}" is missing or invalid, so issues cannot become Runs: fix the configuration first`,
            }),
      );

  const target = input.targetBranch
    ? t({
        zh: `目标分支（${input.targetBranch}）`,
        en: `the target branch (${input.targetBranch})`,
      })
    : t({ zh: '目标分支', en: 'the target branch' });
  const push = github?.push
    ? step(
        'push',
        pushName,
        ['master'],
        t({
          zh: `合并后 Master 把${target}推送到 GitHub，再在 issue 上留言并关闭它；推送失败会通知你，从不强推`,
          en: `After a merge the Master pushes ${target} to GitHub, then comments on the issue and closes it; a failed push notifies you, and it never force-pushes`,
        }),
      )
    : step(
        'push',
        pushName,
        ['human'],
        t({
          zh: `由你来做：合并只到本地的${target}${github ? '，issue 照样关闭并注明' : ''}，需要时自己 git push`,
          en: `Up to you: merges only go to the local ${target}${
            github ? ' (the issue is still closed, with a note)' : ''
          }; git push yourself when needed`,
        }),
      );

  const { upgrade } = input;
  const upgradeStep = canUpgradeItself(upgrade)
    ? step(
        'upgrade',
        upgradeName,
        ['master'],
        t({
          zh: '稳定副本落后于它的 origin 时，等正在执行的工作做完，拉取、构建并重启；新版本起不来就回退到旧版本',
          en: 'When the stable copy falls behind its origin, it waits for running work to finish, then pulls, builds and restarts; if the new version does not start, it rolls back to the old one',
        }),
      )
    : step(
        'upgrade',
        upgradeName,
        ['human'],
        upgrade.auto
          ? t({
              zh: '由你来做：upgrade.auto 已打开，但 Master 不是从稳定副本的构建（dist/cli.js）启动的，不能升级自己；在稳定副本里手动升级（见 docs/running.md）',
              en: 'Up to you: upgrade.auto is on, but the Master was not started from the stable copy’s build (dist/cli.js), so it cannot upgrade itself; upgrade the stable copy by hand (see docs/running.md)',
            })
          : t({
              zh: '由你来做：自动升级没开（upgrade.auto）；在稳定副本里拉取、npm ci、npm run build，再重启 Master',
              en: 'Up to you: automatic upgrades are off (upgrade.auto); in the stable copy, pull, npm ci, npm run build, then restart the Master',
            }),
      );

  const rescout = !scout
    ? step(
        'rescout',
        rescoutName,
        ['human'],
        t({
          zh: '由你来做：想好下一件事，再提需求',
          en: 'Up to you: decide on the next thing and file it',
        }),
      )
    : scout.auto
      ? step(
          'rescout',
          rescoutName,
          ['ai'],
          t({
            zh: `仓库没有在进行中的 Run 时（只等人的 Run 不挡），下次检查（每 ${pollMinutes} 分钟）就再侦察${
              scout.intervalMinutes > 0
                ? `，两次至少隔 ${formatMinutes(scout.intervalMinutes)}`
                : ''
            }，参考新的 Run 记录和被拒的 issue`,
            en: `When the repo has no Run in progress (Runs waiting only for you do not hold it back), it scouts again at the next check (every ${pollMinutes} minutes)${
              scout.intervalMinutes > 0
                ? `, at least ${formatMinutes(scout.intervalMinutes)} apart`
                : ''
            }, taking new Runs and rejected issues into account`,
          }),
        )
      : step(
          'rescout',
          rescoutName,
          ['human'],
          t({
            zh: '由你来做：自动侦察没开（scout.auto: false），在「需求」页点「让 AI 找活」',
            en: 'Up to you: automatic scouting is off (scout.auto: false); click "Let the AI find work" on the Issues page',
          }),
        );

  return [scoutStep, propose, accept, run, push, upgradeStep, rescout];
}

/**
 * Who runs a stage, to start a sentence with: its one agent, or, for a stage with several
 * `agent_candidates`, the one picked from them by difficulty; `none` when it names no agent.
 */
export function stageAgentText(
  stage: Pick<FlowStage, 'agents' | 'byDifficulty'>,
  none: string,
): string {
  const ids = stage.agents.map((a) => a.id);
  if (ids.length === 0) return none;
  if (!stage.byDifficulty || ids.length === 1) return join(ids);
  return t({
    zh: `按难度从 ${join(ids)} 中选出的 Agent`,
    en: `The agent picked by difficulty from ${join(ids)}`,
  });
}

/** The stages of a Run from an issue, as the Run step shows them; null without a flow. */
export function runStages(
  input: Pick<GuideInput, 'flow' | 'github' | 'targetBranch'>,
): CycleStage[] | null {
  if (!input.flow) return null;
  const target = input.targetBranch ?? t({ zh: '目标分支', en: 'the target branch' });
  const noAgent = t({ zh: '未指定 Agent', en: 'No agent set' });
  return input.flow.stages.map((s): CycleStage => {
    const { id, name } = s;
    if (s.kind === 'placeholder') {
      return {
        id,
        name: t({ zh: `${name}（占位）`, en: `${name} (placeholder)` }),
        actors: [],
        note: t({ zh: '暂未实现，直接通过', en: 'Not implemented yet; passes right away' }),
      };
    }
    if (s.kind === 'assess') {
      const agent = stageAgentText(s, noAgent);
      const hours = s.replyTimeoutHours;
      const alone =
        hours === null
          ? ''
          : t({
              zh: `${hours === 0 ? '不等人回复' : `${waitText(hours)}内没人回复`}就自己决定（写明假设后开工，或者不做）`,
              en: `${hours === 0 ? 'without waiting for replies' : `if nobody replies within ${waitText(hours)}`} it decides on its own (going ahead on written-down assumptions, or dropping it)`,
            });
      const work =
        hours === 0
          ? t({
              zh: `${agent} 只读评估需求：合理就开工；有疑问时${alone}`,
              en: `${agent} assesses the requirement read-only: if it makes sense, work starts; with questions, ${alone}`,
            })
          : t({
              zh: `${agent} 只读评估需求：合理就开工；有疑问在 issue 上和你讨论，你同意不做时关闭 issue${alone ? `；${alone}` : ''}`,
              en: `${agent} assesses the requirement read-only: if it makes sense, work starts; questions are discussed with you on the issue, and the issue is closed when you agree not to do it${alone ? `; ${alone}` : ''}`,
            });
      return s.gate
        ? {
            id,
            name,
            actors: ['ai', 'human'],
            note: t({
              zh: `${work}，开工前等你审批`,
              en: `${work}; work waits for your approval before it starts`,
            }),
          }
        : { id, name, actors: ['ai'], note: work };
    }
    if (s.kind === 'command') {
      const work =
        s.commands?.length === 0
          ? t({
              zh: '没有要运行的命令，直接通过',
              en: 'Nothing to run, so it passes right away',
            })
          : s.onFail
            ? t({
                zh: `Master 运行命令（不调用 Agent），有命令失败就带着输出回到「${s.onFail.name}」`,
                en: `The Master runs commands (no agent); when one fails, it goes back to "${s.onFail.name}" with the output`,
              })
            : t({
                zh: 'Master 运行命令（不调用 Agent）',
                en: 'The Master runs commands (no agent)',
              });
      return s.gate
        ? {
            id,
            name,
            actors: ['master', 'human'],
            note: t({
              zh: `${work}，通过后等你审批`,
              en: `${work}; then waits for your approval`,
            }),
          }
        : { id, name, actors: ['master'], note: work };
    }
    if (s.kind === 'merge') {
      if (s.gate) {
        return {
          id,
          name,
          actors: ['human', 'master'],
          note: t({
            zh: `等你审批，批准后 Master 合并到 ${target}`,
            en: `Waits for your approval; once approved the Master merges into ${target}`,
          }),
        };
      }
      return {
        id,
        name,
        actors: ['master'],
        note: input.github?.autoMerge
          ? t({
              zh: `不等审批，Master 直接合并到 ${target}（auto_merge）`,
              en: `No approval: the Master merges into ${target} directly (auto_merge)`,
            })
          : t({
              zh: `模板没设审批，Master 直接合并到 ${target}`,
              en: `The template sets no approval: the Master merges into ${target} directly`,
            }),
      };
    }
    const agent = stageAgentText(s, noAgent);
    const work =
      s.kind === 'review'
        ? t({
            zh: `${agent} 评审，有必须修改的问题就打回${s.onFail ? `「${s.onFail.name}」` : ''}`,
            en: `${agent} reviews; anything that must change sends it back${
              s.onFail ? ` to "${s.onFail.name}"` : ''
            }`,
          })
        : t({
            zh: `${agent} 执行，检查命令通过才算完成`,
            en: `${agent} does the work; it is done only when the checks pass`,
          });
    return s.gate
      ? {
          id,
          name,
          actors: ['ai', 'human'],
          note: t({
            zh: `${work}，完成后等你审批`,
            en: `${work}; then waits for your approval`,
          }),
        }
      : { id, name, actors: ['ai'], note: work };
  });
}

/** Autonomy levels: L0 a human accepts, L1 accepted automatically, L2 also merged without approval. */
export function autonomyLevel(github: GitHubRepoStatus | null): 'L0' | 'L1' | 'L2' | null {
  if (!github) return null;
  if (github.autoAccept.maxRisk === 'none') return github.autoMerge ? null : 'L0';
  return github.autoMerge ? 'L2' : 'L1';
}

/** What happens by itself and what is left to you, in a few words each. */
export function autonomy(
  input: GuideInput,
  rule?: AutoAcceptRule,
): { auto: string[]; you: string[] } {
  const { github } = input;
  const auto: string[] = [t({ zh: '编码', en: 'Coding' }), t({ zh: '评审', en: 'Review' })];
  const you: string[] = [];
  const add = (on: boolean, text: string, offText = text) =>
    on ? auto.push(text) : you.push(offText);
  add(github?.scout?.auto === true, t({ zh: '找活（侦察）', en: 'Finding work (scouting)' }));
  // Accepting can be split: some proposals by itself, the others by you.
  const accepting = (kinds: string) =>
    t({ zh: `采纳${afterChinese(kinds)}`, en: `Accepting ${kinds}` });
  const ranges = acceptRanges(github?.autoAccept ?? { maxRisk: 'none', maxSize: 'L' }, rule);
  if (ranges.auto !== null) auto.push(accepting(ranges.auto));
  if (ranges.human !== null) {
    you.push(
      ranges.auto === null
        ? t({ zh: '采纳提案', en: 'Accepting proposals' })
        : accepting(ranges.human),
    );
  }
  add(
    !mergeNeedsApproval(input),
    t({ zh: '合并', en: 'Merging' }),
    t({ zh: '合并前审批', en: 'Approving merges' }),
  );
  add(github?.push === true, t({ zh: '推送到 GitHub', en: 'Pushing to GitHub' }));
  add(canUpgradeItself(input.upgrade), t({ zh: '升级 Master', en: 'Upgrading the Master' }));
  return { auto, you };
}

// ---- finding work by itself ------------------------------------------------------

export interface ScoutGuide {
  /** The conditions of an automatic scout with their current settings; empty without one. */
  conditions: string[];
  /** Whether a scout runs now, and if not, why. */
  now: string;
  /** The `now` sentence is about something in the way (shown highlighted). */
  waiting: boolean;
}

/**
 * The condition of not waiting for the scout's agent's quota, with the waits of RATE_LIMIT_WAIT:
 * "5、10、20、40 分钟，之后每次 1 小时".
 */
function scoutQuotaCondition(): string {
  const w = RATE_LIMIT_WAIT;
  const steps: string[] = [];
  for (let k = 1; backoffMs(w, k) < w.maxMs; k++) steps.push(String(backoffMs(w, k) / 60_000));
  const margin = w.marginMs / 60_000;
  const hours = w.maxMs / 3_600_000;
  return t({
    zh: `不在等侦察的 Agent 恢复额度：额度用尽或被限流不算失败，也不计入退避；CLI 给了额度重置时间就等到那时再多等 ${margin} 分钟，没给就按连续被限流的次数等 ${join(steps)} 分钟，之后每次 ${hours} 小时`,
    en: `Not waiting for the scout's agent's quota: running out of quota or being rate-limited is no failure and does not count toward the back-off; it waits until the reset time the CLI gave plus ${margin} ${margin === 1 ? 'minute' : 'minutes'}, or without one ${join(steps)} minutes for the limits in a row, then ${hours === 1 ? 'every hour' : `every ${hours} hours`}`,
  });
}

/** When the Master scouts by itself, and why it does not right now. */
export function scoutGuide(
  input: Pick<GuideInput, 'github' | 'pollMinutes'>,
  now = new Date(),
): ScoutGuide {
  const { github } = input;
  if (!github) {
    return {
      conditions: [],
      now: t({
        zh: '还没有接入 GitHub，不会自己找活。',
        en: 'GitHub is not set up yet, so it does not find work by itself.',
      }),
      waiting: true,
    };
  }
  const scout = github.scout;
  if (!scout) {
    return {
      conditions: [],
      now: t({
        zh: '这个仓库没有配置侦察（scout），不会自己找活。',
        en: 'This repo has no scout configured, so it does not find work by itself.',
      }),
      waiting: true,
    };
  }
  const { budget } = github;
  const { pollMinutes } = input;
  const leftToYou = acceptRanges(github.autoAccept).human;
  const conditions = [
    t({ zh: '工作开关是「工作中」', en: 'The work switch is on ("Working")' }),
    t({
      zh: '仓库没有会自己往下走的 Run（排队、执行中、等评估回复且设了超时，或等目标分支上的改动清掉后自动合并）：手上的活做完了才找新活；只等人的 Run 不用等，算进下面的上限',
      en: 'The repo has no Run that goes on by itself (queued, running, waiting for a reply to the assessment that times out, or waiting for uncommitted changes on the target branch to clear before it merges): new work is found only once the current work is done; Runs only a human moves on are not waited for, and count toward the limit below',
    }),
    t({ zh: '不在等 Master 升级', en: 'No Master upgrade is pending' }),
    budget.dailyUsd === null
      ? t({
          zh: '没设每日花费上限（daily_budget_usd），不受花费限制',
          en: 'No daily spending limit is set (daily_budget_usd), so spending does not stop it',
        })
      : t({
          zh: `今天侦察、自动采纳和自动重做的 Run 一共花费不到 ${formatCost(budget.dailyUsd)}（现在 ${formatCost(budget.spentToday)}）`,
          en: `Today's scouts, auto-accepted Runs and automatic redos have spent less than ${formatCost(budget.dailyUsd)} in total (now ${formatCost(budget.spentToday)})`,
        }),
    scout.intervalMinutes > 0
      ? t({
          zh: `距上次侦察满 ${formatMinutes(scout.intervalMinutes)}（interval_minutes）`,
          en: `At least ${formatMinutes(scout.intervalMinutes)} since the last scout (interval_minutes)`,
        })
      : t({
          zh: '不限间隔（interval_minutes: 0）',
          en: 'No minimum interval (interval_minutes: 0)',
        }),
    t({
      zh: `不在退避：侦察没找到需求或失败后先等 ${pollMinutes} 分钟，连续每多一次等待翻倍，最长 ${MAX_SCOUT_BACKOFF_HOURS} 小时；有侦察找到了需求，或目标分支有了新提交，就不再等`,
      en: `Not backing off: after a scout finds nothing or fails it waits ${pollMinutes} ${pollMinutes === 1 ? 'minute' : 'minutes'}, twice as long for each further one in a row, up to ${MAX_SCOUT_BACKOFF_HOURS} hours; a scout that finds work, or a new commit on the target branch, ends the wait`,
    }),
    scoutQuotaCondition(),
    github.autoAccept.maxRisk === 'none'
      ? t({
          zh: `还没处理的提案加上卡住等人的 Run 少于 ${scout.maxProposals} 个（max_proposals）`,
          en: `Fewer than ${scout.maxProposals} proposals awaiting triage and Runs stuck waiting for a human in total (max_proposals)`,
        })
      : t({
          zh: `在自动采纳范围内、还没采纳的提案加上卡住等人的 Run 少于 ${scout.maxProposals} 个（max_proposals）${leftToYou ? `；${leftToYou}留给你处理，不挡侦察` : ''}`,
          en: `Fewer than ${scout.maxProposals} unaccepted proposals within the auto-accept range and Runs stuck waiting for a human in total (max_proposals)${leftToYou ? `; ${leftToYou} are left to you and do not hold the scout back` : ''}`,
        }),
  ];
  if (!scout.auto) {
    return {
      conditions,
      now: t({
        zh: '自动侦察没开（scout.auto: false）：只在你点「让 AI 找活」时侦察，不看上面的条件。',
        en: 'Automatic scouting is off (scout.auto: false): it scouts only when you click "Let the AI find work", whatever the conditions above.',
      }),
      waiting: true,
    };
  }
  if (scout.running) {
    return { conditions, now: t({ zh: '正在侦察。', en: 'Scouting now.' }), waiting: false };
  }
  if (scout.waiting) {
    const why = scoutWaitText(scout.waiting, now);
    return {
      conditions,
      now: t({ zh: `现在没有侦察：${why}。`, en: `Not scouting now: ${why}.` }),
      waiting: true,
    };
  }
  return {
    conditions,
    now: t({
      zh: `条件都满足，下次检查（每 ${input.pollMinutes} 分钟）时就会侦察。`,
      en: `All conditions are met; it scouts at the next check (every ${input.pollMinutes} minutes).`,
    }),
    waiting: false,
  };
}

// ---- notifications and labels ------------------------------------------------------

/** What to do about each notification, in the language in use. */
function noticeHandling(kind: NoticeKind): string {
  switch (kind) {
    case 'approval':
      return t({
        zh: '打开 Run 看改动和评审意见：批准就合并；驳回时写清要改什么，会带着你的意见回去返工（「首页 → 待我处理」）',
        en: 'Open the Run and look at the changes and the review: approve to merge; when rejecting, say what to change and it goes back for rework with your comment ("Home → Needs me")',
      });
    case 'discussion':
      return t({
        zh: '看评估提出的疑问：来自 issue 的直接在 issue 上回复，也可以在 Run 详情页回复；回复后自动重新评估。同意不做也回复说明，评估会给出「不做」的结论。等过评估阶段的 reply_timeout_hours 还没人回复，评估会自己决定',
        en: 'Read the questions of the assessment: for a Run from an issue reply on the issue, or reply on the Run page; it is reassessed after your reply. To agree not to do it, reply saying so and the assessment concludes "drop". If nobody replies within the assess stage\'s reply_timeout_hours, the assessment decides on its own',
      });
    case 'blocked':
      return t({
        zh: '打开 Run 看原因：重试当前 Task（可以换 Agent、附一段说明）；超出预算的调高预算后继续；issue 作者不是仓库成员的，读过目标后确认才开始；不想要了就终止',
        en: 'Open the Run to see why: retry the current Task (with another agent or a note if you like); over budget, raise the budget and continue; for an issue by a non-member of the repo, read the goal and confirm it to start; no longer wanted, cancel it',
      });
    case 'failed':
      return t({
        zh: '看 Run 上的错误说明。从 issue 来的 Run 会带着失败原因自动重做，一个 issue 最多跑 max_run_attempts 次，用完后 issue 关闭并写明每次的原因；不想再做就关闭 issue。保留的工作目录在「工作区」页清理',
        en: 'Read the error on the Run. A Run from an issue is redone automatically with the reason it failed, up to max_run_attempts Runs per issue; after that the issue is closed with every reason. To stop it, close the issue. Clean up the kept working directory on the Workspaces page',
      });
    case 'proposals':
      return t({
        zh: '去 GitHub 看 ares1:proposal 的 issue：要做就加 ares1:ready，不做就关闭为 not planned 并写一句理由',
        en: 'Look at the ares1:proposal issues on GitHub: to do one, add ares1:ready; otherwise close it as not planned with a one-line reason',
      });
    case 'scout':
      return t({
        zh: '去「需求」页看这个仓库侦察的错误和日志，常见原因是 Agent 配置失效、超时或输出不符合约定；修好后自动侦察照常继续，也可以点「让 AI 找活」马上试一次',
        en: 'See the repo\'s scout errors and logs on the Issues page; common causes are a broken agent config, a timeout or output not in the agreed format. Once fixed, automatic scouting goes on as before; click "Let the AI find work" to try right away',
      });
    case 'github':
      return t({
        zh: '看「需求」页的错误信息，多半是 gh 没登录、网络不通或推送不能快进；修好后下次检查会自动重试',
        en: 'See the error on the Issues page; usually gh is not logged in, the network is down or a push cannot fast-forward. Once fixed, the next check retries by itself',
      });
    case 'pull':
      return t({
        zh: '分叉后自动合并有冲突或检查没通过时，在仓库里把 GitHub 上的目标分支合并进本地目标分支（比如 git fetch 后 git merge origin/<分支>），下次检查 Master 会推送上去，已完成 Run 的 issue 随之关闭。检查要用的程序找不到时装好它，下次检查会自动再合并。有未提交的改动时提交或丢弃它们，下次检查会自动拉取',
        en: "When the Master's merge of the diverged branches conflicts or fails the checks, merge the target branch on GitHub into the local one in the repo (e.g. git fetch, then git merge origin/<branch>); the next check pushes it and the issues of completed Runs close. When a program the checks start is missing, install it; the next check merges by itself. For uncommitted changes, commit or discard them; the next check pulls by itself",
      });
    case 'upgrade':
      return t({
        zh: '看「需求」页的升级状态和 upgrade.log；安装目录有改动或分叉时手动整理好稳定副本，有新提交时会再试',
        en: 'See the upgrade status on the Issues page and upgrade.log; if the install directory has changes or has diverged, tidy up the stable copy by hand. It tries again when there are new commits',
      });
  }
}

export interface NoticeRow {
  kind: NoticeKind;
  label: string;
  when: string;
  handle: string;
}

/** The notifications (src/notify/notice.ts, the rules both channels use) and what to do. */
export function noticeRows(): NoticeRow[] {
  return (Object.keys(NOTICE_KINDS) as NoticeKind[]).map((kind) => ({
    kind,
    ...NOTICE_KINDS[kind],
    handle: noticeHandling(kind),
  }));
}

/** How notifications reach you now. */
export function notifyChannel(systemNotify: boolean, webhookNotify = false): string {
  const channel = systemNotify
    ? t({
        zh: 'Master 直接发系统通知（config.yaml 的 notify.system: true；macOS 用通知中心，Linux 用 notify-send，没装 libnotify 就收不到），不用开着看板；看板不再重复发。',
        en: 'The Master sends system notifications itself (notify.system: true in config.yaml; Notification Center on macOS, notify-send on Linux, which needs libnotify installed), so the dashboard need not be open; the dashboard does not send them again.',
      })
    : t({
        zh: '现在由浏览器发通知：要开着至少一个看板标签页（可以在后台），并在顶栏打开「通知」。想不开看板也收到，在 config.yaml 里设 notify.system: true：macOS 用通知中心；Linux 需要 notify-send（libnotify）；其他平台不支持，仍由浏览器发通知。',
        en: 'The browser sends notifications now: keep at least one dashboard tab open (it can be in the background) and turn on notifications in the top bar. To get them without the dashboard, set notify.system: true in config.yaml: Notification Center on macOS; on Linux it needs notify-send (libnotify); other platforms are not supported, and the browser keeps sending them.',
      });
  const webhook = webhookNotify
    ? webhookNote()
    : t({
        zh: '不在这台机器前（比如 Master 跑在没有桌面的服务器上）也想收到，在 config.yaml 里配 notify.webhook，把通知 POST 到 ntfy 一类服务或你自己的地址。',
        en: 'To be reached away from this machine (say, with the Master on a server without a desktop), set notify.webhook in config.yaml to POST notifications to a service such as ntfy or an address of your own.',
      });
  return `${channel}${t({ zh: '', en: ' ' })}${webhook}`;
}

/**
 * Why the test notification cannot be sent: the Master notifies through no channel of its own
 * (system notifications on a platform that has them, or a webhook); null when it can.
 */
export function notifyTestUnavailable(
  systemNotify: boolean,
  webhookNotify: boolean,
): string | null {
  if (systemNotify || webhookNotify) return null;
  return t({
    zh: 'Master 现在没有自己发通知的通道，没有可测的：在 config.yaml 里打开 notify.system（macOS、Linux）或配 notify.webhook，保存后再试。浏览器通知不经过 Master，不在测试之列。',
    en: 'The Master has no channel of its own to notify by, so there is nothing to test: turn on notify.system (macOS, Linux) or set notify.webhook in config.yaml, save, and try again. Browser notifications do not go through the Master and are not tested.',
  });
}

/** How the test notification went through one channel, as shown next to the button. */
export interface NotifyTestLine {
  channel: 'system' | 'webhook';
  label: string;
  tone: Tone;
  text: string;
}

/** One line per channel: sent, why it failed, or not set up. */
export function notifyTestLines(result: NotifyTestResult): NotifyTestLine[] {
  const failed = (reason: string | null) =>
    reason
      ? t({ zh: `发送失败：${reason}`, en: `Failed: ${reason}` })
      : t({ zh: '发送失败', en: 'Failed' });
  const { system, webhook } = result;
  const systemLine: Omit<NotifyTestLine, 'channel' | 'label'> = system.enabled
    ? system.ok
      ? {
          tone: 'success',
          // The command ending well does not mean it showed: Do Not Disturb, Focus or the
          // notification permission may have held it back.
          text: t({
            zh: '已交给系统显示；没看到的话，检查系统的通知设置（勿扰、专注模式、是否允许通知）',
            en: "Handed to the system to show; if you did not see it, check the system's notification settings (Do Not Disturb, Focus, permissions)",
          }),
        }
      : { tone: 'danger', text: failed(system.reason) }
    : {
        tone: 'muted',
        text: system.supported
          ? t({
              zh: '没有打开（config.yaml 的 notify.system）',
              en: 'Off (notify.system in config.yaml)',
            })
          : t({
              zh: 'Master 所在的平台不支持（只支持 macOS、Linux）',
              en: "Not supported on the Master's platform (only macOS and Linux)",
            }),
      };
  const webhookLine: Omit<NotifyTestLine, 'channel' | 'label'> = webhook.enabled
    ? webhook.ok
      ? {
          tone: 'success',
          text:
            webhook.status === null
              ? t({ zh: '对方已接收', en: 'Accepted' })
              : t({
                  zh: `对方已接收（HTTP ${webhook.status}）`,
                  en: `Accepted (HTTP ${webhook.status})`,
                }),
        }
      : { tone: 'danger', text: failed(webhook.reason) }
    : {
        tone: 'muted',
        text: t({
          zh: '没有配置（config.yaml 的 notify.webhook）',
          en: 'Not set (notify.webhook in config.yaml)',
        }),
      };
  return [
    { channel: 'system', label: t({ zh: '系统通知', en: 'System notification' }), ...systemLine },
    { channel: 'webhook', label: t({ zh: 'webhook', en: 'Webhook' }), ...webhookLine },
  ];
}

/** The labels the Master puts on issues; ares1:auto as auto_accept is set now. */
export function labelHelp(autoAccept: GitHubRepoStatus['autoAccept'] | null): [string, string][] {
  const range = autoAccept && acceptRanges(autoAccept).auto;
  const auto = !autoAccept
    ? t({
        zh: '按自动采纳设置（auto_accept）采纳的：哪些提案会被自动采纳，由 max_risk 和 max_size 决定',
        en: 'Accepted by the auto-accept setting (auto_accept): max_risk and max_size decide which proposals are accepted automatically',
      })
    : range === null
      ? t({
          zh: `按自动采纳设置（auto_accept）采纳的。现在自动采纳关闭（max_risk: ${autoAccept.maxRisk}），不会再加这个标签`,
          en: `Accepted by the auto-accept setting (auto_accept). Auto-accept is off now (max_risk: ${autoAccept.maxRisk}), so this label is not added any more`,
        })
      : t({
          zh: `按自动采纳设置（auto_accept）采纳的：现在是${afterChinese(range)}（max_risk: ${autoAccept.maxRisk}，max_size: ${autoAccept.maxSize}）`,
          en: `Accepted by the auto-accept setting (auto_accept): now ${range} (max_risk: ${autoAccept.maxRisk}, max_size: ${autoAccept.maxSize})`,
        });
  return [
    [
      'ares1:proposal',
      t({
        zh: 'AI 提出的需求。采纳就加 ares1:ready；不做就关闭为 not planned，留一句理由，AI 下次会避开',
        en: 'A requirement proposed by the AI. To accept it, add ares1:ready; otherwise close it as not planned with a one-line reason, and the AI avoids it next time',
      }),
    ],
    [
      'ares1:ready',
      t({
        zh: '可以开工。你自己写的 issue 加上它也会被做',
        en: 'Ready to start. Issues you write yourself are done too once they have it',
      }),
    ],
    [
      'ares1:running',
      t({
        zh: '正在处理，issue 上有 Run 的链接',
        en: 'Being worked on; the issue links to the Run',
      }),
    ],
    [
      'ares1:needs-you',
      t({
        zh: 'Run 在等审批、卡住、已暂停，或需求评估有疑问等你在 issue 上回复',
        en: 'The Run is waiting for approval, blocked or paused, or the assessment has questions for you to answer on the issue',
      }),
    ],
    [
      'ares1:failed',
      t({
        zh: 'Run 被终止，或失败次数达到 max_run_attempts 后不再自动重做；重新加 ares1:ready 会重做',
        en: 'The Run was cancelled, or failed max_run_attempts times and is not redone again; add ares1:ready again to redo it',
      }),
    ],
    ['ares1:auto', auto],
  ];
}

// ---- guardrails ----------------------------------------------------------------------

export interface Guardrail {
  title: string;
  /** In effect under the current configuration. */
  on: boolean;
  text: string;
}

/** The guardrails that stay even when everything is automatic. */
export function guardrails(input: GuideInput, working: boolean | undefined): Guardrail[] {
  const { flow, github } = input;
  const items: Guardrail[] = [];

  const coding = flow?.stages.filter((s) => s.kind === 'agent') ?? [];
  const commands = [...new Set(coding.flatMap((s) => s.commands ?? []))];
  const repoDefault = coding.some((s) => s.commands === null);
  const checks = t({ zh: '检查命令', en: 'Checks' });
  items.push(
    !flow
      ? {
          title: checks,
          on: true,
          text: t({
            zh: '每个 Task 完成后跑检查命令（模板或仓库设置的），全部通过才算完成，不通过就带着输出返工',
            en: 'After each Task the checks run (as set by the template or the repo); it is done only when all pass, otherwise it goes back for rework with their output',
          }),
        }
      : commands.length > 0 || repoDefault
        ? {
            title: checks,
            on: true,
            text: t({
              zh: `每个 Task 完成后跑 ${
                commands.length > 0 ? join(commands) : '仓库默认的检查命令'
              }，全部通过才算完成，不通过就带着输出返工`,
              en: `After each Task, ${
                commands.length > 0 ? join(commands) : "the repo's default checks"
              } run; it is done only when all pass, otherwise it goes back for rework with their output`,
            }),
          }
        : {
            title: checks,
            on: false,
            text: t({
              zh: '模板和仓库都没设检查命令：只靠 Agent 自己和评审把关',
              en: 'Neither the template nor the repo sets checks: only the agent itself and the review stand guard',
            }),
          },
  );

  const reviews = flow?.stages.filter((s) => s.kind === 'review') ?? [];
  const review = t({ zh: 'AI 评审', en: 'AI review' });
  items.push(
    !flow
      ? {
          title: review,
          on: true,
          text: t({
            zh: '模板里有评审阶段时，评审 Agent 看每轮改动，有「必须修改」的问题就打回返工',
            en: 'When the template has a review stage, the review agent looks at every round of changes and sends back anything that must change',
          }),
        }
      : reviews.length > 0
        ? {
            title: review,
            on: true,
            text: reviews
              .map((s) => {
                const agent = stageAgentText(s, t({ zh: '评审 Agent', en: 'The review agent' }));
                return t({
                  zh: `${agent} 看每轮改动，有「必须修改」的问题就打回${
                    s.onFail ? `「${s.onFail.name}」` : ''
                  }`,
                  en: `${agent} looks at every round of changes and sends back anything that must change${
                    s.onFail ? ` to "${s.onFail.name}"` : ''
                  }`,
                });
              })
              .join(t({ zh: '；', en: '; ' })),
          }
        : {
            title: review,
            on: false,
            text: t({
              zh: `模板「${flow.templateName}」里没有评审阶段`,
              en: `The template "${flow.templateName}" has no review stage`,
            }),
          },
  );

  if (github) {
    const gate = mergeNeedsApproval(input);
    items.push({
      title: t({ zh: '合并前审批', en: 'Approval before merging' }),
      on: gate,
      text: gate
        ? t({
            zh: '从 issue 来的 Run 合并前等你审批',
            en: 'Runs from issues wait for your approval before merging',
          })
        : github.autoMerge
          ? t({
              zh: '没有：auto_merge 打开，检查和评审通过后直接合并（L2）',
              en: 'None: auto_merge is on, so a Run merges right after the checks and the review pass (L2)',
            })
          : t({
              zh: `没有：模板「${flow?.templateName ?? github.template}」的合并阶段没设审批，检查和评审通过后直接合并`,
              en: `None: the merge stage of the template "${flow?.templateName ?? github.template}" sets no approval, so a Run merges right after the checks and the review pass`,
            }),
    });
  }

  const budgetTitle = t({ zh: 'Run 预算', en: 'Run budget' });
  items.push(
    flow?.budgetUsd !== undefined
      ? {
          title: budgetTitle,
          on: true,
          text: flow.budgetPauses
            ? t({
                zh: `每个 Run 最多花 ${formatCost(flow.budgetUsd)}（模板的 budget_usd），超出后不再开始新的执行，卡住等你调高预算（on_budget_exceeded: pause）`,
                en: `Each Run spends at most ${formatCost(flow.budgetUsd)} (the template's budget_usd); beyond that no new execution starts, and it is blocked until you raise the budget (on_budget_exceeded: pause)`,
              })
            : t({
                zh: `每个 Run 最多花 ${formatCost(flow.budgetUsd)}（模板的 budget_usd），超出后不再开始新的执行，Run 结束、标为失败，从 issue 来的会自动重做`,
                en: `Each Run spends at most ${formatCost(flow.budgetUsd)} (the template's budget_usd); beyond that no new execution starts, the Run ends as failed, and a Run from an issue is redone automatically`,
              }),
        }
      : {
          title: budgetTitle,
          on: false,
          text: flow
            ? t({
                zh: `模板「${flow.templateName}」没设 budget_usd，单个 Run 不限花费`,
                en: `The template "${flow.templateName}" sets no budget_usd, so a single Run's spending is not limited`,
              })
            : t({
                zh: '模板没设 budget_usd 时单个 Run 不限花费',
                en: "Without a budget_usd in the template, a single Run's spending is not limited",
              }),
        },
  );

  if (github) {
    const { dailyUsd, spentToday, reached } = github.budget;
    const dailyTitle = t({ zh: '每日花费上限', en: 'Daily spending limit' });
    items.push(
      dailyUsd === null
        ? {
            title: dailyTitle,
            on: false,
            text: t({
              zh: `没设（daily_budget_usd）：侦察、自动采纳和自动重做不受花费限制。今天已花 ${formatCost(spentToday)}`,
              en: `Not set (daily_budget_usd): spending does not limit scouting, auto-accepting and automatic redos. Spent today: ${formatCost(spentToday)}`,
            }),
          }
        : {
            title: dailyTitle,
            on: true,
            text: t({
              zh: `${formatCost(dailyUsd)}，今天已花 ${formatCost(spentToday)}${
                reached ? '，已达上限' : ''
              }：达到后当天停止自动侦察、自动采纳和失败后的自动重做（第二天再重做，不算用掉一次），手动侦察和你采纳的不受影响`,
              en: `${formatCost(dailyUsd)}, spent today ${formatCost(spentToday)}${
                reached ? ', limit reached' : ''
              }: once reached, automatic scouting, auto-accepting and redoing failed Runs stop for the day (the redo waits for the next day and costs no attempt); manual scouts and what you accept are not affected`,
            }),
          },
    );
    const attempts = github.maxRunAttempts;
    const first = redoDelayMs(1, input.pollMinutes) / 60_000;
    items.push({
      title: t({ zh: '失败后重做的次数上限', en: 'Limit on redoing failed Runs' }),
      on: true,
      text:
        attempts > 1
          ? t({
              zh: `从 issue 来的 Run 失败后自动重做，带上之前的失败原因；重做前先等 ${first} 分钟，每失败一次等待翻倍，最长 ${REDO_BACKOFF_MAX_HOURS} 小时，免得一时的 API 或网络故障很快用完次数；一个 issue 最多跑 ${attempts} 次（max_run_attempts），用完后关闭为 not planned，并写明每次失败的原因`,
              en: `A failed Run from an issue is redone automatically, told why the earlier attempts failed; the redo waits ${first} minute${first === 1 ? '' : 's'} first, twice as long after each further failure, up to ${REDO_BACKOFF_MAX_HOURS} hours, so that a passing API or network outage does not use up the attempts; an issue gets at most ${attempts} Runs (max_run_attempts), after which it is closed as not planned with the reason of every failure`,
            })
          : t({
              zh: '失败的 Run 不重做（max_run_attempts: 1）：issue 关闭为 not planned，并写明失败原因',
              en: 'Failed Runs are not redone (max_run_attempts: 1): the issue is closed as not planned with the reason',
            }),
    });
  }

  const rollback = t({ zh: '升级失败自动回退', en: 'Rollback of failed upgrades' });
  items.push(
    canUpgradeItself(input.upgrade)
      ? {
          title: rollback,
          on: true,
          text: t({
            zh: '新版本拉取、构建或启动失败时回到旧版本并通知你；失败过的提交不再重试',
            en: 'If pulling, building or starting the new version fails, it goes back to the old version and notifies you; a commit that failed is not tried again',
          }),
        }
      : {
          title: rollback,
          on: false,
          text: t({
            zh: '没有自动升级，升级和回退由你手动做（见 docs/running.md）',
            en: 'No automatic upgrades: you upgrade and roll back by hand (see docs/running.md)',
          }),
        },
  );

  items.push({
    title: t({ zh: '工作开关', en: 'Work switch' }),
    on: true,
    text: t({
      zh: `顶栏点一下就停工：不开始新的 Run、不接活、不侦察，正在执行的做完${
        working === undefined ? '' : working ? '。现在：工作中' : '。现在：已停工'
      }`,
      en: `One click in the top bar stops work: no new Runs, no new issues, no scouting; what is running finishes${
        working === undefined ? '' : working ? '. Now: working' : '. Now: stopped'
      }`,
    }),
  });

  items.push({
    title: t({ zh: 'git 历史可回退', en: 'Revertible git history' }),
    on: true,
    text: t({
      zh: 'Run 在单独的 worktree 和分支上做，每个 Task 一个 commit；合并后的任何改动都能用 git revert 回退，推送从不强推',
      en: 'Each Run works in its own worktree and branch, one commit per Task; any merged change can be undone with git revert, and pushes are never forced',
    }),
  });

  return items;
}

// ---- what is in the way ------------------------------------------------------------

export interface IdleInput {
  working: boolean | undefined;
  upgrade: Pick<UpgradeStatus, 'state' | 'message' | 'current' | 'latest'> | undefined;
  /** Runs waiting for an approval or blocked. */
  attention: number;
  github: GitHubRepoStatus | null;
}

// The scout's waiting reason is text from the Master, in the Master's language (which may differ
// from the dashboard's): recognize the reasons said elsewhere in both languages.
function isWorkSwitchReason(reason: string): boolean {
  return reason === '工作开关已关闭' || /^the work switch is off\b/i.test(reason);
}

/** What keeps new Runs from starting right now; empty when nothing is in the way. */
export function idleReasons(input: IdleInput, now = new Date()): string[] {
  const reasons: string[] = [];
  if (input.working === false) {
    reasons.push(
      t({
        zh: '已停工：点顶栏的「已停工」开工。',
        en: 'Stopped: click "Stopped" in the top bar to start working.',
      }),
    );
  }
  const { upgrade } = input;
  // Stopped, the upgrader says it is waiting too without holding anything back: only a
  // waiting for a new version (current ≠ latest) while working keeps new work from starting.
  const upgradePending =
    upgrade?.state === 'upgrading' ||
    (upgrade?.state === 'waiting' &&
      input.working !== false &&
      upgrade.current !== null &&
      upgrade.latest !== null &&
      upgrade.current !== upgrade.latest);
  if (upgradePending) {
    const message = input.upgrade?.message;
    reasons.push(
      t({
        zh: `Master 在等升级或正在升级，这期间不开始新的工作${message ? `（${message}）` : ''}。`,
        en: `The Master is waiting to upgrade or upgrading, and starts no new work meanwhile${
          message ? ` (${message})` : ''
        }.`,
      }),
    );
  }
  if (input.attention > 0) {
    const n = input.attention;
    reasons.push(
      t({
        zh: `有 ${n} 个 Run 在等你审批或卡住了：它们不算在正在执行的 Run 里（每个仓库最多同时执行 concurrency.per_repo 个），排队的 Run 照常开始；只等人的 Run 不挡自动侦察，但和等你处理的提案一起计入上限（max_proposals），攒满后不再侦察。到首页「待我处理」处理。`,
        en: `${n} ${n === 1 ? 'Run is' : 'Runs are'} waiting for your approval or blocked: ${n === 1 ? 'it does' : 'they do'} not count among the executing Runs (up to concurrency.per_repo per repo), so queued Runs still start. Runs waiting only for you do not hold the automatic scout back, but count toward its limit (max_proposals) together with the proposals waiting for you, and it stops scouting once that is reached. Handle ${n === 1 ? 'it' : 'them'} under "Needs me" on the home page.`,
      }),
    );
  }
  const waiting = input.github?.scout?.auto ? input.github.scout.waiting : null;
  // The work switch is said above already.
  if (waiting && !(input.working === false && isWorkSwitchReason(waiting.reason))) {
    const why = scoutWaitText(waiting, now);
    reasons.push(t({ zh: `自动侦察在等：${why}。`, en: `Automatic scouting is waiting: ${why}.` }));
  }
  return reasons;
}

// ---- running the Master -------------------------------------------------------------

/** A path or argument for a POSIX shell, quoted when it has to be. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function under(home: string, path: string): string {
  return `${home.replace(/\/+$/, '')}/${path}`;
}

/**
 * How to start the Master after booting: from its install directory (the stable copy),
 * in the background, its output appended to master.out like the upgrade script does.
 */
export function startCommand(installDir: string | null, home: string): string {
  const dir = installDir
    ? shellQuote(installDir)
    : t({ zh: '<稳定副本目录>', en: '<stable copy directory>' });
  return [
    `cd ${dir}`,
    `nohup node dist/cli.js --home ${shellQuote(home)} >> ${shellQuote(under(home, 'master.out'))} 2>&1 &`,
  ].join('\n');
}

/** How to stop a Master started that way (it pauses running agents first). */
export function stopCommand(home: string): string {
  return `pkill -f ${shellQuote(`dist/cli.js --home ${home}`)}`;
}

/** Where the Master keeps its data and logs. */
export function dataPaths(home: string): { path: string; what: string }[] {
  return [
    {
      path: under(home, 'config.yaml'),
      what: t({
        zh: '全局配置；agents.yaml 和 workflows/ 也在这里',
        en: 'Global configuration; agents.yaml and workflows/ are here too',
      }),
    },
    {
      path: under(home, 'data/ares1.db'),
      what: t({
        zh: '运行状态（SQLite），升级迁移前自动备份，只保留最近 5 份',
        en: 'Run state (SQLite), backed up automatically before a migration; the 5 latest backups are kept',
      }),
    },
    {
      path: under(home, 'data/logs/'),
      what: t({
        zh: `每次 Agent 执行的原始输出和事件，侦察的在 scouts/；Run 或侦察结束 ${RAW_LOG_KEEP_DAYS} 天后自动删掉原始输出（.jsonl 和 .stderr），事件、检查和命令的日志一直保留`,
        en: `Raw output and events of each agent execution; the scouts' are in scouts/. The raw output (.jsonl and .stderr) is deleted automatically ${RAW_LOG_KEEP_DAYS} days after its Run or scout ended; events and the logs of checks and commands are kept`,
      }),
    },
    {
      path: under(home, 'data/artifacts/'),
      what: t({ zh: '评审意见等文本产物', en: 'Text artifacts such as reviews' }),
    },
    {
      path: under(home, 'worktrees/'),
      what: t({ zh: 'Run 的工作目录', en: 'Working directories of Runs' }),
    },
    {
      path: under(home, 'master.out'),
      what: t({
        zh: 'Master 的输出（用上面的命令启动、或自动升级重启后）',
        en: 'Output of the Master (when started with the command above, or restarted by an upgrade)',
      }),
    },
    {
      path: under(home, 'upgrade.log'),
      what: t({ zh: '自动升级脚本的日志', en: 'Log of the automatic upgrade script' }),
    },
    {
      path: under(home, 'keepalive.log'),
      what: t({
        zh: '保活脚本（scripts/keepalive.sh）启动 Master 和发现异常的记录',
        en: 'When the keepalive script (scripts/keepalive.sh) started the Master or found it amiss',
      }),
    },
    {
      path: under(home, 'webhook.curl'),
      what: t({
        zh: '配置了 notify.webhook 时，Master 留给保活和升级脚本的 webhook 设置：Master 停了、起不来时它们也发到 webhook。里面有地址和请求头（可能带 token），只有你能读',
        en: 'With notify.webhook set, the webhook settings the Master leaves for the keepalive and upgrade scripts, so that they reach the webhook too when the Master is down and cannot be started. It holds the address and headers (maybe a token) and only you can read it',
      }),
    },
  ];
}
