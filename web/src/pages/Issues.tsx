import { type ReactNode, useState } from 'react';
import type {
  BacklogRepoStatus,
  BacklogStatus,
  ConfigView,
  GitHubRepoStatus,
  GitHubStatus,
  ProposalSourceStatus,
  ProposalView,
  ProposalWritten,
  UpgradeStatus,
} from '../../../src/api/types.js';
import {
  authorDecides,
  PROPOSAL_SIZES,
  proposalEditable,
  REQUIREMENT_TEXT_MAX,
  REQUIREMENT_TITLE_MAX,
  RISKS,
  SCOUT_GOAL_MAX,
  sizeMeanings,
} from '../../../src/config/flow.js';
import { t } from '../../../src/i18n.js';
import { PROPOSAL_CATEGORIES, type Scout, type ScoutGap } from '../../../src/store/types.js';
import { FailedAttempts, RestartAction } from '../components/Attempts.js';
import { Badge, ConfirmButton, Empty, ErrorBox, TemplateProblems } from '../components/ui.js';
import { api } from '../lib/api.js';
import { repoTemplateChoice, repoTemplateProblems, templateSourceText } from '../lib/config.js';
import { formatCost, formatTime, RUN_STATUS } from '../lib/format.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';
import {
  autoAcceptText,
  backlogExample,
  budgetText,
  CATEGORY,
  deliveryText,
  gapsByGoal,
  gapsHeading,
  githubExample,
  gitlabExample,
  hostLabel,
  issuesUrl,
  platformName,
  pollText,
  RISK,
  SCOUT_STATUS,
  scoutGoalBlocker,
  scoutGoalText,
  scoutPlan,
  scoutWaitText,
  upgradeText,
} from '../lib/issues.js';
import {
  acceptBlocker,
  attemptsText,
  backlogOutdatedBy,
  canReject,
  decidedText,
  draftOf,
  editBlocker,
  editedAtText,
  editedMark,
  editedResultText,
  emptyDraft,
  humanMark,
  mergeProposals,
  PROPOSAL_STATUS,
  type ProposalGroup,
  pendingText,
  proposalCountsText,
  proposalEdit,
  proposalGroups,
  proposalRedoText,
  RECENT_PROPOSALS,
  type RequirementDraft,
  requirementInput,
  restartBlocker,
  restartHint,
  saveEditBlocker,
  scoutProposalFiled,
  writeBlocker,
  writtenText,
} from '../lib/proposals.js';
import { href } from '../lib/router.js';

/** Every pending proposal of the local backlog, and the latest decided ones. */
async function loadProposals(): Promise<ProposalView[]> {
  const [pending, recent] = await Promise.all([
    api.proposals({ status: 'pending' }),
    api.proposals({ limit: RECENT_PROPOSALS }),
  ]);
  return mergeProposals(pending, recent);
}

/**
 * Where requirements come from and the AI scouts that propose them: the issues of GitHub and of
 * GitLab, each platform with its own section, and the local backlog of the repos on neither.
 * `config`: the configuration in use (reloaded by the app), for where each repo's template comes
 * from.
 */
export function IssuesPage({ config }: { config: ConfigView | undefined }) {
  const github = useResource(() => api.github(), 'github');
  const gitlab = useResource(() => api.gitlab(), 'gitlab');
  const backlog = useResource(() => api.backlog(), 'backlog');
  const proposals = useResource(loadProposals, 'proposals');
  const upgrade = useResource(() => api.upgrade(), 'upgrade');
  useReloadOn(upgrade.reload, (e) => e.type.startsWith('upgrade.') || e.type === 'run.status');
  const scouts = useResource(() => api.scouts(), 'scouts');
  // Both platforms' bridges record `github.*` events (GitLab's with `platform: 'gitlab'`). An
  // iteration's events tell whether a repo has one under way, when a scout takes no direction.
  const relevant = (type: string) =>
    type.startsWith('scout.') ||
    type.startsWith('github.') ||
    type.startsWith('iteration.') ||
    type.startsWith('config.') ||
    type === 'run.created';
  useReloadOn(github.reload, (e) => relevant(e.type));
  useReloadOn(gitlab.reload, (e) => relevant(e.type));
  useReloadOn(backlog.reload, (e) => backlogOutdatedBy(e.type));
  useReloadOn(proposals.reload, (e) => backlogOutdatedBy(e.type));
  useReloadOn(scouts.reload, (e) => e.type.startsWith('scout.'));
  const backlogChanged = () => {
    backlog.reload();
    proposals.reload();
  };

  if (!github.data || !gitlab.data) {
    const error = github.error ?? gitlab.error;
    return error ? (
      <ErrorBox>{error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }
  const sources = {
    github: github.data.enabled,
    gitlab: gitlab.data.enabled,
    backlog: backlog.data?.enabled ?? false,
  };
  const none = !sources.github && !sources.gitlab && !sources.backlog;
  const hosts = [
    { status: github.data, reload: github.reload },
    { status: gitlab.data, reload: gitlab.reload },
  ].filter((h) => h.status.enabled);
  return (
    <div className="issues">
      <h1>{t({ zh: '需求', en: 'Issues' })}</h1>
      {none && <NotConfigured />}
      {upgrade.data && <UpgradeCard status={upgrade.data} onChecked={upgrade.reload} />}
      {hosts.map(({ status, reload }) => (
        <HostSection
          key={status.platform}
          status={status}
          config={config}
          onPolled={reload}
          onScoutStarted={scouts.reload}
        />
      ))}
      {!none && <OtherSources github={sources.github} gitlab={sources.gitlab} />}
      <BacklogSection
        status={backlog.data}
        error={backlog.error ?? proposals.error}
        proposals={proposals.data}
        config={config}
        onChanged={backlogChanged}
        onScoutStarted={scouts.reload}
      />
      <h2>{t({ zh: '侦察记录', en: 'Scouts' })}</h2>
      {scouts.error && <ErrorBox>{scouts.error}</ErrorBox>}
      {scouts.data?.length === 0 && (
        <Empty>{t({ zh: '还没有侦察过。', en: 'No scouts yet.' })}</Empty>
      )}
      {scouts.data?.map((s) => (
        <ScoutCard key={s.id} scout={s} />
      ))}
      <p className="muted">
        {t({
          zh: (
            <>
              标签的含义、整个流程怎么转、什么时候通知你，见
              <a href={href.guideSection('labels')}>「说明」页</a>。
            </>
          ),
          en: (
            <>
              What the labels mean, how the whole flow goes and when you are notified: see the{' '}
              <a href={href.guideSection('labels')}>Guide</a>.
            </>
          ),
        })}
      </p>
    </div>
  );
}

/** One code host's section of config.yaml (`github` or `gitlab`): how it goes, then its repos. */
function HostSection(props: {
  status: GitHubStatus;
  config: ConfigView | undefined;
  onPolled: () => void;
  onScoutStarted: () => void;
}) {
  const { status } = props;
  return (
    <>
      <h2>{hostLabel(status)}</h2>
      <Overview status={status} onPolled={props.onPolled} />
      {status.repos.map((r) => (
        <RepoIssues
          key={r.name}
          host={status}
          repo={r}
          config={props.config}
          onStarted={props.onScoutStarted}
        />
      ))}
    </>
  );
}

function Overview({ status, onPolled }: { status: GitHubStatus; onPolled: () => void }) {
  const action = useAction();
  const name = platformName(status.platform);
  const section = `${status.platform}.repos`;
  const cli = status.platform === 'gitlab' ? 'glab' : 'gh';
  const poll = status.platform === 'gitlab' ? api.gitlabPoll : api.githubPoll;
  return (
    <section className="card">
      <p>
        {t({
          zh: (
            <>
              <code>{section}</code> 里的仓库用 {name} Issues 管理需求，Run 只从 issue 来。带{' '}
              <code>ares1:ready</code> 标签的 issue 会自动变成 Run，进展会回写到 issue
              上，合并后关闭 issue。AI 侦察会读代码、文档和 Run 记录，把值得做的事提成带{' '}
              <code>ares1:proposal</code> 标签的 issue，等你采纳。
            </>
          ),
          en: (
            <>
              The repos of <code>{section}</code> keep their backlog in {name} Issues, and their
              Runs only come from issues. An issue labeled <code>ares1:ready</code> becomes a Run by
              itself; progress is written back to the issue, and the issue is closed after the
              merge. The AI scout reads the code, the docs and the Run records, and proposes what is
              worth doing as issues labeled <code>ares1:proposal</code> for you to accept.
            </>
          ),
        })}
      </p>
      <div className="issues-poll">
        <span className="muted">
          {status.account
            ? t({
                zh: `${cli} 账号 ${status.account} · `,
                en: `${cli} account ${status.account} · `,
              })
            : ''}
          {pollText(status.pollMinutes, status.lastPollAt)}
        </span>
        <button
          type="button"
          disabled={action.busy}
          onClick={async () => {
            if ((await action.run(() => poll())) !== undefined) onPolled();
          }}
        >
          {action.busy
            ? t({ zh: '检查中…', en: 'Checking…' })
            : t({ zh: '立即检查', en: 'Check now' })}
        </button>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
      {status.lastError && (
        <ErrorBox>
          {t({
            zh: `${name} 调用失败（${formatTime(status.lastError.at)}），下次检查时重试：`,
            en: `${name} call failed (${formatTime(status.lastError.at)}); retrying at the next check: `,
          })}
          {status.lastError.message}
        </ErrorBox>
      )}
    </section>
  );
}

function UpgradeCard({ status, onChecked }: { status: UpgradeStatus; onChecked: () => void }) {
  const action = useAction();
  return (
    <section className="card">
      <div className="issues-poll">
        <span>
          <strong>{t({ zh: 'Master 自动升级', en: 'Master auto-upgrade' })}</strong>
          {t({ zh: '：', en: ': ' })}
          {upgradeText(status)}
        </span>
        {status.auto && status.installDir && (
          <button
            type="button"
            disabled={action.busy || status.state === 'upgrading'}
            onClick={async () => {
              if ((await action.run(() => api.upgradeCheck())) !== undefined) onChecked();
            }}
          >
            {action.busy
              ? t({ zh: '检查中…', en: 'Checking…' })
              : t({ zh: '检查新版本', en: 'Check for a new version' })}
          </button>
        )}
      </div>
      {status.installDir && (
        <div className="muted">
          {t({ zh: '安装目录：', en: 'Install directory: ' })}
          {status.installDir}
        </div>
      )}
      <ErrorBox>{action.error}</ErrorBox>
    </section>
  );
}

/** A section of config.yaml to copy, folded under its name. */
function ExampleSection(props: { section: 'github' | 'gitlab'; example: string }) {
  return (
    <details className="config-example">
      <summary>
        {t({ zh: `${props.section} 配置示例`, en: `Example ${props.section} section` })}
      </summary>
      <pre className="pre">{props.example}</pre>
    </details>
  );
}

/**
 * Some source of requirements is configured, but not both code hosts: how to add the one missing
 * (or both, when only the local backlog is), with its example. Nothing when both are configured.
 */
function OtherSources({ github, gitlab }: { github: boolean; gitlab: boolean }) {
  if (github && gitlab) return null;
  let text: ReactNode;
  if (!github && !gitlab) {
    text = t({
      zh: (
        <>
          没有接入 GitHub 或 GitLab：下面「本地提案」里的仓库，需求来自 Master
          自己保存的本地提案池。想让仓库改用 GitHub 或 GitLab 的 issue 管理需求，在{' '}
          <code>config.yaml</code> 里加上 <code>github</code> 或 <code>gitlab</code>{' '}
          配置（需要先安装并登录 gh 或 glab），把仓库从 <code>backlog.repos</code> 移到{' '}
          <code>github.repos</code> 或 <code>gitlab.repos</code>：一个仓库只能用一种需求来源。
        </>
      ),
      en: (
        <>
          Neither GitHub nor GitLab is connected: the requirements of the repos under Local backlog
          below come from the local backlog the Master keeps. To have a repo use GitHub or GitLab
          issues instead, add a <code>github</code> or <code>gitlab</code> section to{' '}
          <code>config.yaml</code> (install gh or glab and log in first) and move the repo from{' '}
          <code>backlog.repos</code> to <code>github.repos</code> or <code>gitlab.repos</code>: a
          repo has one source of requirements only.
        </>
      ),
    });
  } else if (!gitlab) {
    text = t({
      zh: (
        <>
          托管在 GitLab（gitlab.com 或自建的）上的项目也能这样用 issue 管理需求：在{' '}
          <code>config.yaml</code> 里加上 <code>gitlab</code> 配置（需要先安装并登录
          glab），把仓库登记到 <code>gitlab.repos</code>；一个仓库只能用一种需求来源。
        </>
      ),
      en: (
        <>
          Projects hosted on GitLab (gitlab.com or a self-hosted one) can keep their backlog in
          issues too: add a <code>gitlab</code> section to <code>config.yaml</code> (install glab
          and log in first) and list the repo under <code>gitlab.repos</code>; a repo has one source
          of requirements only.
        </>
      ),
    });
  } else {
    text = t({
      zh: (
        <>
          托管在 GitHub 上的项目也能这样用 issue 管理需求：在 <code>config.yaml</code> 里加上{' '}
          <code>github</code> 配置（需要先安装并登录 gh），把仓库登记到 <code>github.repos</code>
          ；一个仓库只能用一种需求来源。
        </>
      ),
      en: (
        <>
          Projects hosted on GitHub can keep their backlog in issues too: add a <code>github</code>{' '}
          section to <code>config.yaml</code> (install gh and log in first) and list the repo under{' '}
          <code>github.repos</code>; a repo has one source of requirements only.
        </>
      ),
    });
  }
  return (
    <section className="card">
      <p className={github || gitlab ? 'muted' : undefined}>{text}</p>
      {!github && <ExampleSection section="github" example={githubExample()} />}
      {!gitlab && <ExampleSection section="gitlab" example={gitlabExample()} />}
    </section>
  );
}

/** No source of requirements at all: nothing can create a Run yet, so every way is shown. */
function NotConfigured() {
  return (
    <section className="card">
      <p>
        {t({
          zh: (
            <>
              还没有需求来源，现在建不了 Run：Run 只从 GitHub 或 GitLab 的 issue、或本地提案池来，
              看板不提供手动建 Run。在 <code>config.yaml</code>{' '}
              里加上下面三种配置之一，保存后自动生效；一个仓库只能用一种，只有列在{' '}
              <code>repos</code> 里的仓库才会建 Run。
            </>
          ),
          en: (
            <>
              No source of requirements yet, so no Run can be created: Runs only come from GitHub or
              GitLab issues or the local backlog, and the dashboard does not create Runs by hand.
              Add one of the three sections below to <code>config.yaml</code> and it takes effect by
              itself; a repo uses one of them only, and only repos listed under <code>repos</code>{' '}
              get Runs.
            </>
          ),
        })}
      </p>
      <p>
        {t({
          zh: (
            <>
              接 GitHub（需要先安装并登录 gh）：带 <code>ares1:ready</code> 标签的 issue 建成 Run。
            </>
          ),
          en: (
            <>
              With GitHub (install gh and log in first): issues labeled <code>ares1:ready</code>{' '}
              become Runs.
            </>
          ),
        })}
      </p>
      <pre className="pre">{githubExample()}</pre>
      <p>
        {t({
          zh: (
            <>
              接 GitLab（gitlab.com 或自建的，需要先安装并登录 glab）：同样是带{' '}
              <code>ares1:ready</code> 标签的 issue 建成 Run，项目路径写在 <code>issues_repo</code>{' '}
              里。
            </>
          ),
          en: (
            <>
              With GitLab (gitlab.com or a self-hosted one; install glab and log in first): issues
              labeled <code>ares1:ready</code> become Runs as well, with the project's path in{' '}
              <code>issues_repo</code>.
            </>
          ),
        })}
      </p>
      <pre className="pre">{gitlabExample()}</pre>
      <p>
        {t({
          zh: '不接代码托管（只在本机的仓库，或托管在别处的项目）：AI 侦察把提案写进本地提案池，自动采纳范围内的直接建成 Run，其余的在这一页采纳或拒绝；你也可以在这一页写自己要做的需求。',
          en: 'Without a code host (a repo only on this machine, or hosted elsewhere): the AI scout writes proposals into the local backlog; those within auto-accept become Runs right away, and you accept or reject the others on this page, where you can also write requirements of your own.',
        })}
      </p>
      <pre className="pre">{backlogExample()}</pre>
    </section>
  );
}

/** Problems that keep the Master from working on a repo's requirements. */
function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ErrorBox>
      {problems.map((p) => (
        <div key={p}>{p}</div>
      ))}
    </ErrorBox>
  );
}

/**
 * What a repo's requirements go by, whichever source they come from: the template of its Runs,
 * the scout, auto-accept, approval before merging and today's automatic spend. `extra`: rows of
 * the source's own, shown before the spend.
 */
function SourceSettings(props: {
  repo: ProposalSourceStatus;
  config: ConfigView | undefined;
  extra?: ReactNode;
}) {
  const { repo, config, extra } = props;
  const scout = repo.scout;
  const template = config ? repoTemplateChoice(config, repo.name, repo.template) : null;
  const templateProblems = config ? repoTemplateProblems(config, repo.name) : [];
  return (
    <dl className="meta">
      <div className="wide">
        <dt>{t({ zh: 'Run 模板', en: 'Run template' })}</dt>
        <dd>
          {repo.template}
          {template && (
            <span className="muted">
              {t({
                zh: `（${templateSourceText(template)}）`,
                en: ` (${templateSourceText(template)})`,
              })}
            </span>
          )}
          <TemplateProblems problems={templateProblems} />
        </dd>
      </div>
      <div className="wide">
        <dt>{t({ zh: '侦察', en: 'Scout' })}</dt>
        <dd>
          {scout ? (
            <>
              {scout.agent}
              {t({ zh: '，', en: ', ' })}
              {scoutPlan(scout)}
              {scout.lastAt
                ? t({
                    zh: `；上次 ${formatTime(scout.lastAt)}`,
                    en: `; last ${formatTime(scout.lastAt)}`,
                  })
                : ''}
              {scout.auto && !scout.running && scout.waiting && (
                <div className="muted">
                  {t({ zh: '现在没有自动侦察：', en: 'Not scouting by itself now: ' })}
                  {scoutWaitText(scout.waiting)}
                </div>
              )}
            </>
          ) : (
            <span className="muted">{t({ zh: '未配置', en: 'Not configured' })}</span>
          )}
        </dd>
      </div>
      <div className="wide">
        <dt>{t({ zh: '自动采纳', en: 'Auto-accept' })}</dt>
        <dd>{autoAcceptText(repo.autoAccept)}</dd>
      </div>
      <div>
        <dt>{t({ zh: '合并前审批', en: 'Approval before merge' })}</dt>
        <dd>
          {repo.autoMerge
            ? t({
                zh: '不用审批，检查和评审通过后自动合并',
                en: 'Not needed: merges once checks and review pass',
              })
            : t({ zh: '需要你审批', en: 'You approve' })}
        </dd>
      </div>
      {extra}
      <div>
        <dt>{t({ zh: '今日自动花费', en: 'Automatic spend today' })}</dt>
        <dd>{budgetText(repo.budget)}</dd>
      </div>
    </dl>
  );
}

/**
 * The scout started by hand, for a repo of any source, with an optional direction it plans its
 * iteration around; nothing without a scout configured. While the repo has an iteration under way
 * the direction is disabled, saying why, and the scout starts without one.
 */
function ScoutAction({ repo, onStarted }: { repo: ProposalSourceStatus; onStarted: () => void }) {
  const action = useAction();
  const [goal, setGoal] = useState('');
  const scout = repo.scout;
  if (!scout) return null;
  const blocker = scoutGoalBlocker(scout);
  const given = blocker === null ? goal.trim() : '';
  return (
    <>
      <div className="form-actions scout-action">
        <button
          type="button"
          className="btn-primary"
          disabled={scout.running || action.busy || repo.problems.length > 0}
          onClick={async () => {
            const started = await action.run(() => api.startScout(repo.name, given || undefined));
            if (started !== undefined) {
              setGoal('');
              onStarted();
            }
          }}
        >
          {scout.running
            ? t({ zh: '侦察中…', en: 'Scouting…' })
            : t({ zh: '让 AI 找活', en: 'Let the AI find work' })}
        </button>
        <input
          value={blocker === null ? goal : ''}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={SCOUT_GOAL_MAX}
          disabled={blocker !== null}
          title={blocker ?? undefined}
          placeholder={t({
            zh: '方向（可选）：比如「支持导出报表」，侦察会围绕它规划一个迭代',
            en: 'Direction (optional), e.g. "export reports": the scout plans an iteration around it',
          })}
          aria-label={t({ zh: '侦察的方向', en: "The scout's direction" })}
        />
        <span className="muted">
          {t({
            zh: `最多提 ${scout.maxProposals} 条，通常要几分钟`,
            en: `Up to ${scout.maxProposals} ${scout.maxProposals === 1 ? 'proposal' : 'proposals'}; usually takes a few minutes`,
          })}
        </span>
      </div>
      {blocker !== null && scout.openIteration && (
        <div className="muted">
          {blocker}{' '}
          <a href={href.iteration(scout.openIteration.id)}>
            {t({ zh: '查看迭代', en: 'See the iteration' })}
          </a>
        </div>
      )}
      <ErrorBox>{action.error}</ErrorBox>
    </>
  );
}

/** A repo whose issues are on a code host: `host` is the platform's status it is listed in. */
function RepoIssues(props: {
  host: GitHubStatus;
  repo: GitHubRepoStatus;
  config: ConfigView | undefined;
  onStarted: () => void;
}) {
  const { host, repo, config, onStarted } = props;
  return (
    <section className="card repo">
      <div className="repo-head">
        <h2>{repo.name}</h2>
        <span className="muted">
          {hostLabel(host)}
          {repo.issuesRepo && ` · ${repo.issuesRepo}`}
        </span>
        {repo.issuesRepo && (
          <span className="issues-links">
            <a
              href={issuesUrl(host, repo.issuesRepo, 'ares1:proposal')}
              target="_blank"
              rel="noreferrer"
            >
              {t({ zh: '待审提案', en: 'Proposals to review' })}
            </a>
            <a href={issuesUrl(host, repo.issuesRepo)} target="_blank" rel="noreferrer">
              {t({ zh: '全部 issue', en: 'All issues' })}
            </a>
          </span>
        )}
      </div>
      <Problems problems={repo.problems} />
      <SourceSettings
        repo={repo}
        config={config}
        extra={
          <div className="wide">
            <dt>{t({ zh: '交付方式', en: 'Delivery' })}</dt>
            <dd>{deliveryText(repo)}</dd>
          </div>
        }
      />
      <ScoutAction repo={repo} onStarted={onStarted} />
    </section>
  );
}

/**
 * The local backlog of the repos on neither GitHub nor GitLab (backlog.repos): a card per repo
 * with its settings and its proposals, pending ones first. Also shown, without the settings, for
 * repos taken out of backlog.repos that still have proposals, so that pending ones can be rejected.
 */
function BacklogSection(props: {
  status: BacklogStatus | undefined;
  error: string | undefined;
  proposals: ProposalView[] | undefined;
  config: ConfigView | undefined;
  onChanged: () => void;
  onScoutStarted: () => void;
}) {
  const { status, proposals } = props;
  if (!status) return props.error ? <ErrorBox>{props.error}</ErrorBox> : null;
  const groups = proposalGroups(status.repos, proposals ?? []);
  if (!status.enabled && groups.length === 0) return null;
  return (
    <>
      <h2>{t({ zh: '本地提案', en: 'Local backlog' })}</h2>
      <ErrorBox>{props.error}</ErrorBox>
      {status.enabled && <BacklogOverview status={status} onPolled={props.onChanged} />}
      {groups.map((g) => (
        <BacklogRepo
          key={g.repo}
          group={g}
          loading={proposals === undefined}
          config={props.config}
          onChanged={props.onChanged}
          onScoutStarted={props.onScoutStarted}
        />
      ))}
    </>
  );
}

function BacklogOverview({ status, onPolled }: { status: BacklogStatus; onPolled: () => void }) {
  const action = useAction();
  return (
    <section className="card">
      <p>
        {t({
          zh: (
            <>
              <code>backlog.repos</code> 里的仓库不接 GitHub 或 GitLab（不能同时列在{' '}
              <code>github.repos</code> 或 <code>gitlab.repos</code> 里），需求来自 Master
              自己保存的本地提案池：AI 侦察读代码、文档和 Run
              记录，把值得做的事写成提案；在自动采纳范围内的直接建成
              Run，其余的等你在下面采纳，或者填上理由拒绝。拒绝的理由会交给这个仓库之后的侦察，免得换个说法再提。你自己要做的事，在仓库卡片上点「写需求」写进去，马上开工或者先存着。
            </>
          ),
          en: (
            <>
              The repos of <code>backlog.repos</code> use neither GitHub nor GitLab (they cannot be
              listed under <code>github.repos</code> or <code>gitlab.repos</code> as well): their
              requirements come from the local backlog the Master keeps. The AI scout reads the
              code, the docs and the Run records and writes down what is worth doing as proposals;
              those within auto-accept become Runs right away, and the others wait for you to accept
              them below or reject them with a reason. The reason goes to the repo's later scouts,
              so that they do not propose the same thing in other words. To have something of your
              own done, click "Write a requirement" on the repo's card, and start it at once or keep
              it for later.
            </>
          ),
        })}
      </p>
      <div className="issues-poll">
        <span className="muted">{pollText(status.pollMinutes, status.lastPollAt)}</span>
        <button
          type="button"
          disabled={action.busy}
          onClick={async () => {
            if ((await action.run(() => api.backlogPoll())) !== undefined) onPolled();
          }}
        >
          {action.busy
            ? t({ zh: '检查中…', en: 'Checking…' })
            : t({ zh: '立即检查', en: 'Check now' })}
        </button>
      </div>
      <ErrorBox>{action.error}</ErrorBox>
      {status.lastError && (
        <ErrorBox>
          {t({
            zh: `上一轮检查有没做成的事（${formatTime(status.lastError.at)}），下次检查时重试：`,
            en: `The last check could not do everything (${formatTime(status.lastError.at)}); retrying at the next check: `,
          })}
          {status.lastError.message}
        </ErrorBox>
      )}
    </section>
  );
}

function BacklogRepo(props: {
  group: ProposalGroup;
  /** The proposals are not loaded yet. */
  loading: boolean;
  config: ConfigView | undefined;
  onChanged: () => void;
  onScoutStarted: () => void;
}) {
  const { group, loading } = props;
  const { status } = group;
  const counts = proposalCountsText(group.proposals);
  return (
    <section className="card repo">
      <div className="repo-head">
        <h2>{group.repo}</h2>
        {counts && <span className="muted">{counts}</span>}
      </div>
      {status ? (
        <>
          <Problems problems={status.problems} />
          <SourceSettings repo={status} config={props.config} />
          {status.scout ? (
            <ScoutAction repo={status} onStarted={props.onScoutStarted} />
          ) : (
            <p className="muted">
              {t({
                zh: '没有配置侦察（scout），这个仓库没有 AI 提的新提案，只做你写的需求。',
                en: 'No scout is configured, so the repo gets no new proposals from the AI; it works on the requirements you write.',
              })}
            </p>
          )}
          <WriteRequirement repo={status} onWritten={props.onChanged} />
        </>
      ) : (
        <p className="muted">
          {t({
            zh: '已经不在 config.yaml 的 backlog.repos 里：不再侦察，也不能再采纳它的提案；待处理的还可以拒绝。',
            en: 'No longer in backlog.repos of config.yaml: it is not scouted and its proposals cannot be accepted any more; pending ones can still be rejected.',
          })}
        </p>
      )}
      {group.proposals.length > 0 ? (
        <ul className="proposal-list">
          {group.proposals.map((p) => (
            <ProposalItem key={p.id} proposal={p} group={group} onChanged={props.onChanged} />
          ))}
        </ul>
      ) : (
        !loading && (
          <div className="muted proposals-none">
            {t({ zh: '还没有本地提案。', en: 'No proposals yet.' })}
          </div>
        )
      )}
    </section>
  );
}

/**
 * A requirement a human writes into the repo's local backlog (POST /api/proposals): a button that
 * opens the form, which starts it at once or keeps it pending for the human to accept. Disabled,
 * saying why, while the repo has problems. Only cards of backlog.repos have it: the repos of
 * GitHub and GitLab take their requirements as issues there.
 */
function WriteRequirement({ repo, onWritten }: { repo: BacklogRepoStatus; onWritten: () => void }) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [written, setWritten] = useState<ProposalWritten | null>(null);
  const update = (patch: Partial<RequirementDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const blocker = writeBlocker(repo, draft);
  const repoBlocked = repo.problems.length > 0;
  const write = async (start: boolean) => {
    if (blocker !== null) return;
    const result = await action.run(() =>
      api.writeProposal(requirementInput(repo.name, draft, start)),
    );
    if (result !== undefined) {
      setDraft(emptyDraft());
      setOpen(false);
      setWritten(result);
      onWritten();
    }
  };
  return (
    <div className="write-requirement">
      <div className="form-actions">
        <button
          type="button"
          aria-expanded={open}
          disabled={!open && repoBlocked}
          title={!open && repoBlocked ? (blocker ?? undefined) : undefined}
          onClick={() => {
            setOpen(!open);
            setWritten(null);
            action.clearError();
          }}
        >
          {open ? t({ zh: '收起', en: 'Close' }) : t({ zh: '写需求', en: 'Write a requirement' })}
        </button>
        <span className="muted">
          {repoBlocked && !open
            ? blocker
            : t({
                zh: '把你自己要做的事写成提案：马上开工，或者先存着以后再采纳',
                en: 'Write down something you want done as a proposal: start it at once, or keep it to accept later',
              })}
        </span>
      </div>
      {written && (
        <div className="hint write-requirement-done">
          {writtenText(written)}
          {written.run && (
            <>
              {' '}
              <a href={href.run(written.run.id)}>{t({ zh: '查看 Run', en: 'See the Run' })}</a>
            </>
          )}
        </div>
      )}
      {open && (
        <div className="form write-requirement-form">
          <RequirementFields draft={draft} update={update} />
          <ErrorBox>{action.error}</ErrorBox>
          <div className="form-actions write-requirement-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={action.busy || blocker !== null}
              title={blocker ?? undefined}
              onClick={() => write(true)}
            >
              {t({ zh: '写入并开工', en: 'Write and start' })}
            </button>
            <button
              type="button"
              disabled={action.busy || blocker !== null}
              title={blocker ?? undefined}
              onClick={() => write(false)}
            >
              {t({ zh: '先存着', en: 'Keep for later' })}
            </button>
            <span className="muted">
              {blocker ??
                t({
                  zh: '开工就马上建 Run，不受每天自动采纳的条数和预算限制；先存着的不会自动采纳，等你点「采纳」',
                  en: "Starting creates a Run at once, outside the day's auto-accept count and budget; one kept for later is never accepted automatically and waits for you to accept it",
                })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The fields of a requirement: title, what to do, why, evidence, acceptance criteria, category,
 * size and risk, with what the size chosen means. The form that writes a requirement and the one
 * that edits a pending proposal are the same.
 */
function RequirementFields(props: {
  draft: RequirementDraft;
  update: (patch: Partial<RequirementDraft>) => void;
}) {
  const { draft, update } = props;
  return (
    <>
      <label className="field">
        <span>{t({ zh: '标题', en: 'Title' })}</span>
        <input
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
          maxLength={REQUIREMENT_TITLE_MAX}
          placeholder={t({
            zh: '一句话说清要什么，比如「Run 列表能导出成 CSV」',
            en: 'What you want, in one line, e.g. "Export the Run list as CSV"',
          })}
        />
      </label>
      <label className="field">
        <span>{t({ zh: '要做什么', en: 'What to do' })}</span>
        <textarea
          value={draft.what}
          onChange={(e) => update({ what: e.target.value })}
          maxLength={REQUIREMENT_TEXT_MAX}
          rows={5}
          placeholder={t({
            zh: '具体要改什么、做到什么程度；Agent 照着它做',
            en: 'What exactly to change, and how far to go; the agents work from it',
          })}
        />
      </label>
      <label className="field">
        <span>{t({ zh: '为什么（可选）', en: 'Why (optional)' })}</span>
        <textarea
          value={draft.why}
          onChange={(e) => update({ why: e.target.value })}
          maxLength={REQUIREMENT_TEXT_MAX}
          rows={2}
          placeholder={t({
            zh: '为什么要做；Agent 取舍时会参考',
            en: 'Why it is worth doing; the agents weigh their choices by it',
          })}
        />
      </label>
      <label className="field">
        <span>{t({ zh: '证据（可选，每行一条）', en: 'Evidence (optional, one per line)' })}</span>
        <textarea
          value={draft.evidence}
          onChange={(e) => update({ evidence: e.target.value })}
          rows={2}
          placeholder={t({
            zh: '相关的文件、行号或现象，比如：\nweb/src/pages/Home.tsx',
            en: 'Files, lines or symptoms it is about, e.g.:\nweb/src/pages/Home.tsx',
          })}
        />
      </label>
      <label className="field">
        <span>
          {t({
            zh: '验收标准（可选，每行一条）',
            en: 'Acceptance criteria (optional, one per line)',
          })}
        </span>
        <textarea
          value={draft.acceptance}
          onChange={(e) => update({ acceptance: e.target.value })}
          rows={3}
          placeholder={t({
            zh: '怎样算做完，比如：\n能导出\n有测试',
            en: 'How to tell it is done, e.g.:\nThe list can be exported\nThere are tests',
          })}
        />
      </label>
      <div className="form-row write-requirement-kind">
        <label className="field">
          <span>{t({ zh: '类别', en: 'Category' })}</span>
          <select
            value={draft.category}
            onChange={(e) => update({ category: e.target.value as RequirementDraft['category'] })}
          >
            {PROPOSAL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t({ zh: '大小', en: 'Size' })}</span>
          <select
            value={draft.size}
            onChange={(e) => update({ size: e.target.value as RequirementDraft['size'] })}
          >
            {PROPOSAL_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t({ zh: '风险', en: 'Risk' })}</span>
          <select
            value={draft.risk}
            onChange={(e) => update({ risk: e.target.value as RequirementDraft['risk'] })}
          >
            {RISKS.map((r) => (
              <option key={r} value={r}>
                {RISK[r].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="hint">
        {t({ zh: `大小 ${draft.size}：`, en: `Size ${draft.size}: ` })}
        {sizeMeanings()[draft.size]}
      </div>
    </>
  );
}

/**
 * Editing a pending proposal of its own (PATCH /api/proposals/:id): the form that writes a
 * requirement, filled with what the proposal says now; only the fields changed are sent.
 * `onSaved`: the proposal as the Master recorded it, accepted already when the edit put a scout's
 * proposal within auto-accept.
 */
function EditProposal(props: {
  proposal: ProposalView;
  onSaved: (saved: ProposalView) => void;
  onCancel: () => void;
}) {
  const { proposal: p, onSaved, onCancel } = props;
  const action = useAction();
  const [before] = useState(() => draftOf(p));
  const [draft, setDraft] = useState(before);
  const update = (patch: Partial<RequirementDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const blocker = saveEditBlocker(before, draft);
  const save = async () => {
    if (blocker !== null) return;
    const saved = await action.run(() => api.editProposal(p.id, proposalEdit(before, draft)));
    if (saved !== undefined) onSaved(saved);
  };
  return (
    <div className="form write-requirement-form proposal-edit-form">
      <RequirementFields draft={draft} update={update} />
      <ErrorBox>{action.error}</ErrorBox>
      <div className="form-actions write-requirement-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={action.busy || blocker !== null}
          title={blocker ?? undefined}
          onClick={save}
        >
          {t({ zh: '保存', en: 'Save' })}
        </button>
        <button type="button" disabled={action.busy} onClick={onCancel}>
          {t({ zh: '取消', en: 'Cancel' })}
        </button>
        <span className="muted">
          {blocker ??
            (authorDecides(p)
              ? t({
                  zh: '保存后还是等你采纳；事件列表里记下改了哪些项',
                  en: 'Once saved it still waits for you to accept it; the event list records which fields changed',
                })
              : t({
                  zh: '保存后如果落在自动采纳范围内，会照常自动采纳；事件列表里记下改了哪些项',
                  en: 'Once saved, it is accepted automatically as usual if it falls within auto-accept; the event list records which fields changed',
                }))}
        </span>
      </div>
    </div>
  );
}

/**
 * One proposal: what it is, folded open to read why, the evidence, what to do and how to tell it
 * is done. Pending ones of their own can be edited, accepted, or rejected with a reason; decided
 * ones say how. One a human edited is marked so.
 */
function ProposalItem(props: {
  proposal: ProposalView;
  group: ProposalGroup;
  onChanged: () => void;
}) {
  const { proposal: p, group, onChanged } = props;
  const action = useAction();
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<ProposalView | null>(null);
  const status = PROPOSAL_STATUS[p.status];
  const blocker = acceptBlocker(p, group.status);
  const cannotEdit = editBlocker(p, group.status);
  const waiting = pendingText(p, group.status?.autoAccept ?? null);
  const human = humanMark(p);
  const edited = editedMark(p);
  const decided = decidedText(p);
  const attempts = attemptsText(p);
  const redo = proposalRedoText(p);
  const accept = async () => {
    if ((await action.run(() => api.acceptProposal(p.id))) !== undefined) onChanged();
  };
  const reject = async () => {
    if (!canReject(p, reason)) return;
    if ((await action.run(() => api.rejectProposal(p.id, reason.trim()))) !== undefined) {
      setReason('');
      onChanged();
    }
  };
  return (
    <li className={`proposal proposal-${p.status}`}>
      <details>
        <summary>
          <Badge tone={status.tone}>{status.label}</Badge>{' '}
          {human && (
            <>
              <Badge tone="neutral">{human}</Badge>{' '}
            </>
          )}
          {edited && (
            <>
              <span title={editedAtText(p) ?? undefined}>
                <Badge tone="neutral">{edited}</Badge>
              </span>{' '}
            </>
          )}
          <span className="proposal-title">{p.title}</span>{' '}
          <Badge tone={RISK[p.risk].tone}>{RISK[p.risk].label}</Badge>{' '}
          <span className="muted">
            {CATEGORY[p.category]} · {p.size} · {formatTime(p.createdAt)}
          </span>
        </summary>
        <ProposalBody proposal={p} />
      </details>
      {(p.status === 'accepted' || p.status === 'failed') && (
        <div className="proposal-outcome">
          {p.auto && <Badge tone="active">{t({ zh: '已自动采纳', en: 'Auto-accepted' })}</Badge>}
          {decided && <span className="muted">{decided}</span>}
          {p.runId && (
            <>
              <a href={href.run(p.runId)}>Run {p.runId}</a>
              {p.runStatus && (
                <Badge tone={RUN_STATUS[p.runStatus].tone}>{RUN_STATUS[p.runStatus].label}</Badge>
              )}
            </>
          )}
          {attempts && <span className="muted">{attempts}</span>}
        </div>
      )}
      {redo && <div className="hint">{redo}</div>}
      <FailedAttempts failures={p.failures} />
      {p.restartable && (
        <RestartAction
          proposalId={p.id}
          hint={restartHint(p)}
          blocker={restartBlocker(p, group.status)}
          onRestarted={onChanged}
        />
      )}
      {p.status === 'rejected' && (
        <div className="proposal-outcome">
          {decided && <span className="muted">{decided}</span>}
          {p.rejectReason && (
            <span className="proposal-reason">
              {t({ zh: '理由：', en: 'Reason: ' })}
              {p.rejectReason}
            </span>
          )}
        </div>
      )}
      {p.iterationId && (
        <div className="hint">
          {p.status === 'pending'
            ? t({
                zh: '这是一个迭代的一步，和迭代一起整体采纳或拒绝：',
                en: 'A step of an iteration, accepted or rejected with it as a whole: ',
              })
            : t({ zh: '这是一个迭代的一步：', en: 'A step of an iteration: ' })}
          <a href={href.iteration(p.iterationId)}>
            {t({ zh: '查看迭代', en: 'See the iteration' })}
          </a>
        </div>
      )}
      {saved && <div className="hint">{editedResultText(saved)}</div>}
      {proposalEditable(p) && (
        <>
          {waiting && <div className="hint">{waiting}</div>}
          <div className="proposal-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={action.busy || editing || blocker !== null}
              title={blocker ?? undefined}
              onClick={accept}
            >
              {t({ zh: '采纳', en: 'Accept' })}
            </button>
            <button
              type="button"
              aria-expanded={editing}
              disabled={action.busy || (!editing && cannotEdit !== null)}
              title={cannotEdit ?? undefined}
              onClick={() => {
                setEditing(!editing);
                setSaved(null);
              }}
            >
              {editing ? t({ zh: '收起修改', en: 'Close editing' }) : t({ zh: '修改', en: 'Edit' })}
            </button>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t({
                zh: '拒绝的理由（必填，之后的侦察会看到）',
                en: 'Reason to reject (required; later scouts see it)',
              })}
              aria-label={t({ zh: '拒绝的理由', en: 'Reason to reject' })}
            />
            <ConfirmButton
              label={t({ zh: '拒绝', en: 'Reject' })}
              confirmLabel={t({ zh: '确认拒绝', en: 'Confirm reject' })}
              disabled={action.busy || editing || !canReject(p, reason)}
              onConfirm={reject}
            />
          </div>
          <ErrorBox>{action.error}</ErrorBox>
          {editing && (
            <EditProposal
              proposal={p}
              onSaved={(result) => {
                setEditing(false);
                setSaved(result);
                onChanged();
              }}
              onCancel={() => setEditing(false)}
            />
          )}
        </>
      )}
    </li>
  );
}

/** What the scout wrote: why, the evidence, what to do and the acceptance criteria. */
function ProposalBody({ proposal: p }: { proposal: ProposalView }) {
  const list = (items: string[]) => (
    <ul>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a recorded list that never changes
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
  return (
    <div className="proposal-body">
      {p.why.trim() !== '' && (
        <>
          <h4>{t({ zh: '为什么', en: 'Why' })}</h4>
          <p>{p.why}</p>
        </>
      )}
      {p.evidence.length > 0 && (
        <>
          <h4>{t({ zh: '证据', en: 'Evidence' })}</h4>
          {list(p.evidence)}
        </>
      )}
      <h4>{t({ zh: '要做什么', en: 'What to do' })}</h4>
      <p>{p.what}</p>
      {p.acceptance.length > 0 && (
        <>
          <h4>{t({ zh: '验收标准', en: 'Acceptance criteria' })}</h4>
          {list(p.acceptance)}
        </>
      )}
    </div>
  );
}

function ScoutCard({ scout }: { scout: Scout }) {
  const status = SCOUT_STATUS[scout.status];
  const goal = scoutGoalText(scout.goal);
  return (
    <section className="card scout">
      <div className="scout-head">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span>{formatTime(scout.startedAt)}</span>
        <span className="muted">
          {scout.trigger === 'manual'
            ? t({ zh: '手动', en: 'Manual' })
            : t({ zh: '自动', en: 'Automatic' })}{' '}
          · {scout.agentId}
          {scout.model ? t({ zh: `（${scout.model}）`, en: ` (${scout.model})` }) : ''} ·{' '}
          {formatCost(scout.costUsd)}
        </span>
      </div>
      {goal && <div className="scout-goal">{goal}</div>}
      {scout.error && <ErrorBox>{scout.error}</ErrorBox>}
      {scout.status === 'completed' && scout.proposals.length === 0 && (
        <div className="muted">
          {t({ zh: '没有找到值得做的事。', en: 'Found nothing worth doing.' })}
        </div>
      )}
      {scout.proposals.length > 0 && (
        <ul className="proposals">
          {scout.proposals.map((p) => {
            const filed = scoutProposalFiled(p);
            return (
              <li key={p.title}>
                {p.issue ? (
                  <a href={p.issue.url} target="_blank" rel="noreferrer">
                    #{p.issue.number} {p.title}
                  </a>
                ) : (
                  <span>{p.title}</span>
                )}{' '}
                <Badge tone={RISK[p.risk].tone}>{RISK[p.risk].label}</Badge>{' '}
                <span className="muted">
                  {CATEGORY[p.category]} · {p.size}
                  {filed.where === 'local' &&
                    t({ zh: ' · 已写入本地提案', en: ' · In the local backlog' })}
                </span>
                {filed.auto && (
                  <>
                    {' '}
                    <Badge tone="active">{t({ zh: '已自动采纳', en: 'Auto-accepted' })}</Badge>
                  </>
                )}
                {p.error && (
                  <div className="error-text">
                    {t({ zh: '没能建 issue：', en: 'Could not create the issue: ' })}
                    {p.error}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <GapAnalysis gaps={scout.gaps} />
    </section>
  );
}

/**
 * What the scout found the project cannot do yet, by README goal, with the evidence: the direction
 * it judged before proposing. Folded, so that the list of scouts stays short.
 */
function GapAnalysis({ gaps }: { gaps: ScoutGap[] | null }) {
  const heading = gapsHeading(gaps);
  if (heading === null) return null;
  if (!gaps || gaps.length === 0) return <div className="muted gaps-none">{heading}</div>;
  return (
    <details className="gaps">
      <summary>{heading}</summary>
      {gapsByGoal(gaps).map((group) => (
        <div key={group.goal} className="gap-goal">
          <div className="gap-goal-name">{group.goal}</div>
          <ul>
            {group.gaps.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a recorded list that never changes
              <li key={i}>
                {g.gap}
                <ul className="gap-evidence">
                  {g.evidence.map((e, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a recorded list that never changes
                    <li key={j}>{e}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}
