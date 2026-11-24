import type { GitHubRepoStatus, GitHubStatus, UpgradeStatus } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Scout, ScoutGap } from '../../../src/store/types.js';
import { Badge, Empty, ErrorBox } from '../components/ui.js';
import { api } from '../lib/api.js';
import { formatCost, formatTime } from '../lib/format.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';
import {
  autoAcceptText,
  budgetText,
  CATEGORY,
  gapsByGoal,
  gapsHeading,
  issuesUrl,
  RISK,
  SCOUT_STATUS,
  scoutPlan,
  scoutWaitText,
  upgradeText,
} from '../lib/issues.js';
import { href } from '../lib/router.js';

/** GitHub issues as the backlog and the AI scouts that propose them. */
export function IssuesPage() {
  const github = useResource(() => api.github(), 'github');
  const upgrade = useResource(() => api.upgrade(), 'upgrade');
  useReloadOn(upgrade.reload, (e) => e.type.startsWith('upgrade.') || e.type === 'run.status');
  const scouts = useResource(() => api.scouts(), 'scouts');
  const relevant = (type: string) =>
    type.startsWith('scout.') ||
    type.startsWith('github.') ||
    type.startsWith('config.') ||
    type === 'run.created';
  useReloadOn(github.reload, (e) => relevant(e.type));
  useReloadOn(scouts.reload, (e) => e.type.startsWith('scout.'));

  if (!github.data) {
    return github.error ? (
      <ErrorBox>{github.error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }
  return (
    <div className="issues">
      <h1>{t({ zh: '需求', en: 'Issues' })}</h1>
      {github.data.enabled ? (
        <Overview status={github.data} onPolled={github.reload} />
      ) : (
        <NotConfigured />
      )}
      {upgrade.data && <UpgradeCard status={upgrade.data} onChecked={upgrade.reload} />}
      {github.data.repos.map((r) => (
        <RepoIssues key={r.name} repo={r} onStarted={scouts.reload} />
      ))}
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

function Overview({ status, onPolled }: { status: GitHubStatus; onPolled: () => void }) {
  const action = useAction();
  return (
    <section className="card">
      <p>
        {t({
          zh: (
            <>
              需求用 GitHub Issues 管理，Run 只从 issue 来。带 <code>ares1:ready</code> 标签的 issue
              会自动变成 Run，进展会回写到 issue 上，合并后关闭 issue。AI 侦察会读代码、文档和 Run
              记录，把值得做的事提成带 <code>ares1:proposal</code> 标签的 issue，等你采纳。
            </>
          ),
          en: (
            <>
              The backlog lives in GitHub Issues, and Runs only come from issues. An issue labeled{' '}
              <code>ares1:ready</code> becomes a Run by itself; progress is written back to the
              issue, and the issue is closed after the merge. The AI scout reads the code, the docs
              and the Run records, and proposes what is worth doing as issues labeled{' '}
              <code>ares1:proposal</code> for you to accept.
            </>
          ),
        })}
      </p>
      <div className="issues-poll">
        <span className="muted">
          {status.account
            ? t({ zh: `gh 账号 ${status.account} · `, en: `gh account ${status.account} · ` })
            : ''}
          {t({
            zh: `每 ${status.pollMinutes} 分钟检查一次`,
            en: `Checks every ${status.pollMinutes} ${status.pollMinutes === 1 ? 'minute' : 'minutes'}`,
          })}
          {status.lastPollAt
            ? t({
                zh: ` · 上次 ${formatTime(status.lastPollAt)}`,
                en: ` · last ${formatTime(status.lastPollAt)}`,
              })
            : ''}
        </span>
        <button
          type="button"
          disabled={action.busy}
          onClick={async () => {
            if ((await action.run(() => api.githubPoll())) !== undefined) onPolled();
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
            zh: `GitHub 调用失败（${formatTime(status.lastError.at)}），下次检查时重试：`,
            en: `GitHub call failed (${formatTime(status.lastError.at)}); retrying at the next check: `,
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

function NotConfigured() {
  return (
    <section className="card">
      <p>
        {t({
          zh: (
            <>
              还没有接入 GitHub，现在建不了 Run：需求只从 GitHub issue 来，看板不提供手动建
              Run，不配置 <code>github</code> 就不能建 Run。在 <code>config.yaml</code> 里加上{' '}
              <code>github</code> 配置后自动生效（需要先安装并登录 gh），只有列在 <code>repos</code>{' '}
              里的仓库才会从 issue 建 Run：
            </>
          ),
          en: (
            <>
              GitHub is not connected yet, so no Run can be created: the backlog only comes from
              GitHub issues and the dashboard does not create Runs by hand. Add a{' '}
              <code>github</code> section to <code>config.yaml</code> and it takes effect by itself
              (install gh and log in first); only repos listed under <code>repos</code> get Runs
              from issues:
            </>
          ),
        })}
      </p>
      <pre className="pre">
        {t({
          zh: `github:
  account: my-account        # 可选：用 gh 的哪个账号
  repos:
    my-repo:                 # 看板上登记的仓库名
      template: self-dev     # 从 issue 建 Run 用的模板
      scout:
        agent: claude-reviewer
        auto: true           # 没有在进行中的 Run 时自动侦察（只等人的 Run 不挡）；false = 只手动触发
      auto_accept:
        max_risk: none       # 自动采纳到哪个风险等级：none / low / mid / high
        max_size: L          # 自动采纳到哪个大小：S / M / L
      auto_merge: false      # 从 issue 来的 Run 合并前不再等你审批
      push: false            # 合并后自动推送到 GitHub
      # daily_budget_usd: 20 # 每天自动花费的上限，不写 = 不限
      max_run_attempts: 3    # 一个 issue 最多跑几次 Run（含第一次），失败后自动重做`,
          en: `github:
  account: my-account        # optional: which gh account to use
  repos:
    my-repo:                 # the repo name registered on the dashboard
      template: self-dev     # template of the Runs created from issues
      scout:
        agent: claude-reviewer
        auto: true           # scout by itself when no Run is in progress (Runs waiting only for you do not hold it back); false = by hand only
      auto_accept:
        max_risk: none       # highest risk accepted automatically: none / low / mid / high
        max_size: L          # largest size accepted automatically: S / M / L
      auto_merge: false      # Runs from issues merge without waiting for your approval
      push: false            # push to GitHub after merging
      # daily_budget_usd: 20 # daily limit of automatic spend; omitted = no limit
      max_run_attempts: 3    # Runs an issue gets at most, the first included; failed ones are redone`,
        })}
      </pre>
    </section>
  );
}

function RepoIssues({ repo, onStarted }: { repo: GitHubRepoStatus; onStarted: () => void }) {
  const action = useAction();
  const scout = repo.scout;
  return (
    <section className="card repo">
      <div className="repo-head">
        <h2>{repo.name}</h2>
        {repo.issuesRepo && (
          <span className="issues-links">
            <a href={issuesUrl(repo.issuesRepo, 'ares1:proposal')} target="_blank" rel="noreferrer">
              {t({ zh: '待审提案', en: 'Proposals to review' })}
            </a>
            <a href={issuesUrl(repo.issuesRepo)} target="_blank" rel="noreferrer">
              {t({ zh: '全部 issue', en: 'All issues' })}
            </a>
          </span>
        )}
      </div>
      {repo.problems.length > 0 && (
        <ErrorBox>
          {repo.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </ErrorBox>
      )}
      <dl className="meta">
        <div>
          <dt>{t({ zh: 'Run 模板', en: 'Run template' })}</dt>
          <dd>{repo.template}</dd>
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
        <div>
          <dt>{t({ zh: '推送到 GitHub', en: 'Push to GitHub' })}</dt>
          <dd>
            {repo.push
              ? t({ zh: '合并后自动推送', en: 'Pushed after each merge' })
              : t({ zh: '由你推送', en: 'You push' })}
          </dd>
        </div>
        <div>
          <dt>{t({ zh: '今日自动花费', en: 'Automatic spend today' })}</dt>
          <dd>{budgetText(repo.budget)}</dd>
        </div>
      </dl>
      {scout && (
        <div className="form-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={scout.running || action.busy || repo.problems.length > 0}
            onClick={async () => {
              if ((await action.run(() => api.startScout(repo.name))) !== undefined) onStarted();
            }}
          >
            {scout.running
              ? t({ zh: '侦察中…', en: 'Scouting…' })
              : t({ zh: '让 AI 找活', en: 'Let the AI find work' })}
          </button>
          <span className="muted">
            {t({
              zh: `最多提 ${scout.maxProposals} 条，通常要几分钟`,
              en: `Up to ${scout.maxProposals} ${scout.maxProposals === 1 ? 'proposal' : 'proposals'}; usually takes a few minutes`,
            })}
          </span>
        </div>
      )}
      <ErrorBox>{action.error}</ErrorBox>
    </section>
  );
}

function ScoutCard({ scout }: { scout: Scout }) {
  const status = SCOUT_STATUS[scout.status];
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
      {scout.error && <ErrorBox>{scout.error}</ErrorBox>}
      {scout.status === 'completed' && scout.proposals.length === 0 && (
        <div className="muted">
          {t({ zh: '没有找到值得做的事。', en: 'Found nothing worth doing.' })}
        </div>
      )}
      {scout.proposals.length > 0 && (
        <ul className="proposals">
          {scout.proposals.map((p) => (
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
              </span>
              {p.issue?.auto && (
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
          ))}
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
