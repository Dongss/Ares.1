import type { ConfigView, GitHubRepoStatus, UpgradeStatus } from '../../../src/api/types.js';
import { effectiveBudget, issueRunOverrides } from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import { NOTICE_KINDS, type NoticeKind } from '../../../src/notify/notice.js';
import { buildFlow, type FlowStage } from './flow.js';
import { formatCost, type Tone } from './format.js';
import { RISK_UP_TO, scoutWaitText } from './issues.js';

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
  /** The Runs created from its issues (`issueFlow`); null without GitHub or a valid template. */
  flow: IssueFlow | null;
  /** The registered repo's target branch; null when not known. */
  targetBranch: string | null;
  upgrade: Pick<UpgradeStatus, 'auto' | 'installDir'>;
}

/** How a Run created from an issue goes: the template with the `auto_merge` override applied. */
export interface IssueFlow {
  templateName: string;
  stages: FlowStage[];
  /** The Run's budget in USD; undefined = no limit. */
  budgetUsd: number | undefined;
}

/**
 * The flow of the Runs a repo's issues become, as the Master creates them (same overrides,
 * `issueRunOverrides`). null when the template is missing or invalid.
 */
export function issueFlow(
  config: Pick<ConfigView, 'templates' | 'agents'>,
  github: Pick<GitHubRepoStatus, 'template' | 'autoMerge'>,
  repoVerifyCommands: string[] | null,
): IssueFlow | null {
  const template = config.templates.find((t) => t.id === github.template);
  if (!template) return null;
  const overrides = issueRunOverrides(template, github.autoMerge) ?? {};
  return {
    templateName: template.name ?? template.id,
    stages: buildFlow({ template, overrides, repoVerifyCommands, agents: config.agents }),
    budgetUsd: effectiveBudget(template, overrides),
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
 * The steps of the loop: scout → file issues → accept → Run → push → upgrade → scout again,
 * each with who does it under the current configuration. Steps the configuration leaves to a
 * human say so ("up to you").
 */
export function cycleSteps(input: GuideInput): CycleStep[] {
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
  const acceptName = t({ zh: '采纳', en: 'Accept' });
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

  let accept: CycleStep;
  if (!github) {
    accept = step(
      'accept',
      acceptName,
      ['human'],
      t({
        zh: '由你来做：接入 GitHub 后，给要做的 issue 加 ares1:ready',
        en: 'Up to you: once GitHub is set up, label the issues to do with ares1:ready',
      }),
    );
  } else if (github.autoAccept.maxRisk === 'none') {
    accept = step(
      'accept',
      acceptName,
      ['human'],
      t({
        zh: '由你来做：给要做的 issue 加 ares1:ready；不做的关闭为 not planned 并写一句理由',
        en: 'Up to you: label the issues to do with ares1:ready; close the others as not planned with a one-line reason',
      }),
    );
  } else {
    const { maxPerDay } = github.autoAccept;
    const { dailyUsd } = github.budget;
    const limits = [
      maxPerDay !== null
        ? t({ zh: `每天最多 ${maxPerDay} 条`, en: `at most ${maxPerDay} a day` })
        : '',
      dailyUsd !== null
        ? t({
            zh: `当天自动花费到 ${formatCost(dailyUsd)} 就停`,
            en: `stops for the day once automatic spending reaches ${formatCost(dailyUsd)}`,
          })
        : '',
    ].filter(Boolean);
    const risk = RISK_UP_TO[github.autoAccept.maxRisk];
    accept = step(
      'accept',
      acceptName,
      ['master', 'human'],
      t({
        zh: `${risk}、大小不是 L 的提案自动采纳（加 ares1:ready 和 ares1:auto）${
          limits.length > 0 ? `，${limits.join('，')}` : ''
        }；其余的由你来做：加 ares1:ready 或关闭`,
        en: `Accepted automatically: ${risk} proposals that are not size L (labeled ares1:ready and ares1:auto)${
          limits.length > 0 ? `, ${limits.join(', ')}` : ''
        }; the rest are up to you: add ares1:ready or close them`,
      }),
    );
  }

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
              zh: `Master 每 ${pollMinutes} 分钟查一次带 ares1:ready 的 issue，按模板「${input.flow.templateName}」建 Run，进展回写到 issue；同一时间只执行一个 Run`,
              en: `Every ${pollMinutes} minutes the Master looks for issues labeled ares1:ready, creates Runs from them with the template "${input.flow.templateName}" and reports progress on the issue; one Run executes at a time`,
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
            zh: `仓库没有未结束的 Run 时，下次检查（每 ${pollMinutes} 分钟）就再侦察${
              scout.intervalHours > 0 ? `，两次至少隔 ${scout.intervalHours} 小时` : ''
            }，参考新的 Run 记录和被拒的 issue`,
            en: `When the repo has no unfinished Run, it scouts again at the next check (every ${pollMinutes} minutes)${
              scout.intervalHours > 0 ? `, at least ${scout.intervalHours} hours apart` : ''
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
      const agent = s.agent?.id ?? noAgent;
      const work = t({
        zh: `${agent} 只读评估需求：合理就开工；有疑问在 issue 上和你讨论，你同意不做时关闭 issue`,
        en: `${agent} assesses the requirement read-only: if it makes sense, work starts; questions are discussed with you on the issue, and the issue is closed when you agree not to do it`,
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
    const agent = s.agent?.id ?? noAgent;
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
export function autonomy(input: GuideInput): { auto: string[]; you: string[] } {
  const { github } = input;
  const auto: string[] = [t({ zh: '编码', en: 'Coding' }), t({ zh: '评审', en: 'Review' })];
  const you: string[] = [];
  const add = (on: boolean, text: string, offText = text) =>
    on ? auto.push(text) : you.push(offText);
  add(github?.scout?.auto === true, t({ zh: '找活（侦察）', en: 'Finding work (scouting)' }));
  const risk = github?.autoAccept.maxRisk ?? 'none';
  const accepting = t({ zh: '采纳提案', en: 'Accepting proposals' });
  add(
    risk !== 'none',
    risk === 'none'
      ? accepting
      : t({ zh: `采纳${RISK_UP_TO[risk]}的提案`, en: `Accepting ${RISK_UP_TO[risk]} proposals` }),
    accepting,
  );
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
  const conditions = [
    t({ zh: '工作开关是「工作中」', en: 'The work switch is on ("Working")' }),
    t({
      zh: '仓库没有未结束的 Run（排队、执行中、等审批、卡住、已暂停都算）：手上的活做完了才找新活',
      en: 'The repo has no unfinished Run (queued, running, waiting for approval, blocked and paused all count): new work is found only once the current work is done',
    }),
    t({ zh: '不在等 Master 升级', en: 'No Master upgrade is pending' }),
    budget.dailyUsd === null
      ? t({
          zh: '没设每日花费上限（daily_budget_usd），不受花费限制',
          en: 'No daily spending limit is set (daily_budget_usd), so spending does not stop it',
        })
      : t({
          zh: `今天侦察和自动采纳的 Run 一共花费不到 ${formatCost(budget.dailyUsd)}（现在 ${formatCost(budget.spentToday)}）`,
          en: `Today's scouts and auto-accepted Runs have spent less than ${formatCost(budget.dailyUsd)} in total (now ${formatCost(budget.spentToday)})`,
        }),
    scout.intervalHours > 0
      ? t({
          zh: `距上次侦察满 ${scout.intervalHours} 小时（interval_hours）`,
          en: `At least ${scout.intervalHours} hours since the last scout (interval_hours)`,
        })
      : t({
          zh: '不限间隔（interval_hours: 0）：上次侦察失败或没找到新需求也不额外等',
          en: 'No minimum interval (interval_hours: 0): no extra wait even if the last scout failed or found nothing new',
        }),
    t({
      zh: `还没处理的提案少于 ${scout.maxProposals} 条（max_proposals）`,
      en: `Fewer than ${scout.maxProposals} proposals await triage (max_proposals)`,
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
        zh: '看评估提出的疑问：来自 issue 的直接在 issue 上回复，也可以在 Run 详情页回复；回复后自动重新评估。同意不做也回复说明，评估会给出「不做」的结论',
        en: 'Read the questions of the assessment: for a Run from an issue reply on the issue, or reply on the Run page; it is reassessed after your reply. To agree not to do it, reply saying so and the assessment concludes "drop"',
      });
    case 'blocked':
      return t({
        zh: '打开 Run 看原因：重试当前 Task（可以换 Agent、附一段说明）；超出预算的调高预算后继续；不想要了就终止',
        en: 'Open the Run to see why: retry the current Task (with another agent or a note if you like); over budget, raise the budget and continue; no longer wanted, cancel it',
      });
    case 'failed':
      return t({
        zh: '看 Run 上的错误说明；要重做就给 issue 重新加 ares1:ready。保留的工作目录在「工作区」页清理',
        en: 'Read the error on the Run; to redo it, add ares1:ready to the issue again. Clean up the kept working directory on the Workspaces page',
      });
    case 'proposals':
      return t({
        zh: '去 GitHub 看 ares1:proposal 的 issue：要做就加 ares1:ready，不做就关闭为 not planned 并写一句理由',
        en: 'Look at the ares1:proposal issues on GitHub: to do one, add ares1:ready; otherwise close it as not planned with a one-line reason',
      });
    case 'github':
      return t({
        zh: '看「需求」页的错误信息，多半是 gh 没登录、网络不通或推送不能快进；修好后下次检查会自动重试',
        en: 'See the error on the Issues page; usually gh is not logged in, the network is down or a push cannot fast-forward. Once fixed, the next check retries by itself',
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
export function notifyChannel(systemNotify: boolean): string {
  return systemNotify
    ? t({
        zh: 'Master 直接发系统通知（config.yaml 的 notify.system: true），不用开着看板；看板不再重复发。',
        en: 'The Master sends system notifications itself (notify.system: true in config.yaml), so the dashboard need not be open; the dashboard does not send them again.',
      })
    : t({
        zh: '现在由浏览器发通知：要开着至少一个看板标签页（可以在后台），并在顶栏打开「通知」。想不开看板也收到，在 config.yaml 里设 notify.system: true（macOS 通知中心）。',
        en: 'The browser sends notifications now: keep at least one dashboard tab open (it can be in the background) and turn on notifications in the top bar. To get them without the dashboard, set notify.system: true in config.yaml (macOS Notification Center).',
      });
}

/** The labels the Master puts on issues; ares1:auto as auto_accept is set now. */
export function labelHelp(autoAccept: GitHubRepoStatus['autoAccept'] | null): [string, string][] {
  const auto = !autoAccept
    ? t({
        zh: '按自动采纳设置（auto_accept）采纳的：风险在 max_risk 以内、大小不是 L',
        en: 'Accepted by the auto-accept setting (auto_accept): risk within max_risk and size not L',
      })
    : autoAccept.maxRisk === 'none'
      ? t({
          zh: '按自动采纳设置（auto_accept）采纳的。现在自动采纳关闭（max_risk: none），不会再加这个标签',
          en: 'Accepted by the auto-accept setting (auto_accept). Auto-accept is off now (max_risk: none), so this label is not added any more',
        })
      : t({
          zh: `按自动采纳设置（auto_accept）采纳的：现在是${RISK_UP_TO[autoAccept.maxRisk]}、大小不是 L 的提案（max_risk: ${autoAccept.maxRisk}）`,
          en: `Accepted by the auto-accept setting (auto_accept): now ${RISK_UP_TO[autoAccept.maxRisk]} proposals that are not size L (max_risk: ${autoAccept.maxRisk})`,
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
        zh: 'Run 失败或被终止；重新加 ares1:ready 会重做',
        en: 'The Run failed or was cancelled; add ares1:ready again to redo it',
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
                const agent = s.agent?.id ?? t({ zh: '评审 Agent', en: 'The review agent' });
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
          text: t({
            zh: `每个 Run 最多花 ${formatCost(flow.budgetUsd)}（模板的 budget_usd），超出后不再开始新的执行，默认卡住等你调高预算`,
            en: `Each Run spends at most ${formatCost(flow.budgetUsd)} (the template's budget_usd); beyond that no new execution starts, and by default it is blocked until you raise the budget`,
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
              zh: `没设（daily_budget_usd）：侦察和自动采纳不受花费限制。今天已花 ${formatCost(spentToday)}`,
              en: `Not set (daily_budget_usd): spending does not limit scouting and auto-accepting. Spent today: ${formatCost(spentToday)}`,
            }),
          }
        : {
            title: dailyTitle,
            on: true,
            text: t({
              zh: `${formatCost(dailyUsd)}，今天已花 ${formatCost(spentToday)}${
                reached ? '，已达上限' : ''
              }：达到后当天停止自动侦察和自动采纳，手动侦察和你采纳的不受影响`,
              en: `${formatCost(dailyUsd)}, spent today ${formatCost(spentToday)}${
                reached ? ', limit reached' : ''
              }: once reached, automatic scouting and auto-accepting stop for the day; manual scouts and what you accept are not affected`,
            }),
          },
    );
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

function isWaitingForWorkReason(reason: string): boolean {
  return reason.startsWith('等 ') || /^waiting for /i.test(reason);
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
        zh: `有 ${n} 个 Run 在等你审批或卡住了：它们让出了执行位，但仓库有未结束的 Run 时不会自动侦察。到首页「待我处理」处理。`,
        en: `${n} ${n === 1 ? 'Run is' : 'Runs are'} waiting for your approval or blocked: ${n === 1 ? 'it frees' : 'they free'} the execution slot, but the repo is not scouted automatically while it has unfinished Runs. Handle ${n === 1 ? 'it' : 'them'} under "Needs me" on the home page.`,
      }),
    );
  }
  const waiting = input.github?.scout?.auto ? input.github.scout.waiting : null;
  // The work switch and unfinished Runs are said above already.
  if (
    waiting &&
    !(input.working === false && isWorkSwitchReason(waiting.reason)) &&
    !(input.attention > 0 && isWaitingForWorkReason(waiting.reason))
  ) {
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
        zh: '运行状态（SQLite），升级迁移前自动备份',
        en: 'Run state (SQLite), backed up automatically before a migration',
      }),
    },
    {
      path: under(home, 'data/logs/'),
      what: t({
        zh: '每次 Agent 执行的原始输出和事件，侦察的在 scouts/',
        en: "Raw output and events of each agent execution; the scouts' are in scouts/",
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
  ];
}
