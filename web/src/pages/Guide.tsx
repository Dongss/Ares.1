import { Fragment, type ReactNode, useEffect, useState } from 'react';
import type {
  ConfigView,
  GitHubRepoStatus,
  NotifyTestResult,
  RunSummary,
} from '../../../src/api/types.js';
import { brandName, brandSlogan } from '../../../src/brand.js';
import { changeRequestTerms } from '../../../src/config/flow.js';
import { join, t } from '../../../src/i18n.js';
import type { HostPlatform, Repo } from '../../../src/store/types.js';
import { Badge, Empty, ErrorBox, Pre } from '../components/ui.js';
import { api } from '../lib/api.js';
import { BLOCK_KIND, blockKindText, shortSha } from '../lib/format.js';
import {
  ACTOR,
  type Actor,
  autonomy,
  autonomyLevel,
  blockReasons,
  type CycleStage,
  type CycleStep,
  cycleSteps,
  dataPaths,
  GUIDE_SECTIONS,
  type GuideInput,
  type GuideSection,
  guardrails,
  guideRepos,
  idleReasons,
  isGuideSection,
  issueFlow,
  iterationGuide,
  labelHelp,
  noticeRows,
  notifyChannel,
  notifyTestLines,
  notifyTestUnavailable,
  runStages,
  scoutGuide,
  startCommand,
  stopCommand,
} from '../lib/guide.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';
import {
  acceptRanges,
  deliveryText,
  GITHUB,
  issuesUrl,
  newIssueUrl,
  platformName,
} from '../lib/issues.js';
import { ONBOARD_STEPS, onboardStepSummary, onboardStepTitle } from '../lib/onboard.js';
import { href } from '../lib/router.js';
import { attentionCount } from '../lib/runs.js';

/**
 * How this self-hosting project works: the loop, what is left to you, when you
 * are notified, the guardrails. Everything that depends on the configuration is read from the
 * API and follows config.yaml as it is reloaded.
 */
export function GuidePage(props: {
  config: ConfigView | undefined;
  configError: string | undefined;
  repos: Repo[] | undefined;
  runs: RunSummary[] | undefined;
  /** Section to scroll to. */
  section?: string;
}) {
  const github = useResource(() => api.github(), 'github');
  const gitlab = useResource(() => api.gitlab(), 'gitlab');
  const upgrade = useResource(() => api.upgrade(), 'upgrade');
  const health = useResource(() => api.health(), 'health');
  const config = (type: string) => type.startsWith('config.');
  // GitLab's bridge records its events under the same types, with platform: 'gitlab'.
  const hostEvent = (e: { type: string }) =>
    config(e.type) ||
    e.type.startsWith('scout.') ||
    e.type.startsWith('github.') ||
    e.type.startsWith('issue.') ||
    e.type === 'run.created' ||
    e.type === 'run.status' ||
    e.type === 'master.working';
  useReloadOn(github.reload, hostEvent);
  useReloadOn(gitlab.reload, hostEvent);
  useReloadOn(
    upgrade.reload,
    (e) =>
      config(e.type) ||
      e.type.startsWith('upgrade.') ||
      e.type === 'run.status' ||
      e.type === 'master.working',
  );
  useReloadOn(health.reload, (e) => config(e.type) || e.type === 'master.working');
  const [picked, setPicked] = useState<string>();

  const loaded = Boolean(github.data && gitlab.data && upgrade.data && health.data && props.config);
  const { section } = props;
  useEffect(() => {
    if (loaded && section && isGuideSection(section)) {
      document.getElementById(`guide-${section}`)?.scrollIntoView({ block: 'start' });
    }
  }, [loaded, section]);

  const error = github.error ?? gitlab.error ?? upgrade.error ?? health.error ?? props.configError;
  if (!github.data || !gitlab.data || !upgrade.data || !health.data || !props.config) {
    return error ? (
      <ErrorBox>{error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }

  const choices = guideRepos([github.data, gitlab.data]);
  const chosen = choices.find((c) => c.key === picked) ?? choices[0] ?? null;
  const repoStatus = chosen?.status ?? null;
  const repo = repoStatus ? props.repos?.find((r) => r.name === repoStatus.name) : undefined;
  // Both platforms have repos: say which one each is on.
  const bothPlatforms = new Set(choices.map((c) => c.host.platform)).size > 1;
  const input: GuideInput = {
    github: repoStatus,
    host: chosen?.host ?? GITHUB,
    pollMinutes: chosen?.pollMinutes ?? github.data.pollMinutes,
    perRepo: props.config.perRepo,
    maxRuns: props.config.maxRuns,
    flow: repoStatus ? issueFlow(props.config, repoStatus, repo?.verifyCommands ?? null) : null,
    targetBranch: repo?.targetBranch ?? null,
    upgrade: upgrade.data,
  };
  const home = props.config.dir;
  const working = health.data.working;

  const content: Record<GuideSection, ReactNode> = {
    intro: (
      <Intro
        input={input}
        working={working}
        version={health.data.version}
        hostEnabled={github.data.enabled || gitlab.data.enabled}
      />
    ),
    onboard: <OnboardSection />,
    cycle: <CycleSection input={input} />,
    scout: <ScoutSection input={input} />,
    you: <YouSection input={input} home={home} working={working} />,
    notify: (
      <NotifySection
        systemNotify={health.data.systemNotify}
        webhookNotify={health.data.webhookNotify}
      />
    ),
    labels: <LabelsSection autoAccept={input.github?.autoAccept ?? null} />,
    guards: <GuardsSection input={input} working={working} />,
    faq: (
      <FaqSection
        input={input}
        home={home}
        idle={idleReasons({
          working,
          upgrade: upgrade.data,
          attention: props.runs ? attentionCount(props.runs) : 0,
          github: input.github,
        })}
      />
    ),
  };

  return (
    <div className="guide">
      <h1>{t({ zh: '说明', en: 'Guide' })}</h1>
      <nav className="guide-toc" aria-label={t({ zh: '目录', en: 'Contents' })}>
        {GUIDE_SECTIONS.map((s) => (
          <a key={s.id} href={href.guideSection(s.id)}>
            {s.title}
          </a>
        ))}
      </nav>
      {choices.length > 1 && (
        <div className="filter-row guide-repos">
          <span className="muted">
            {t({ zh: '按哪个仓库的设置说明：', en: 'Explain with the settings of:' })}
          </span>
          {choices.map((c) => (
            <button
              key={c.key}
              type="button"
              className={c.key === chosen?.key ? 'filter-chip active' : 'filter-chip'}
              onClick={() => setPicked(c.key)}
            >
              {bothPlatforms
                ? `${c.status.name} · ${platformName(c.host.platform)}`
                : c.status.name}
            </button>
          ))}
        </div>
      )}
      {GUIDE_SECTIONS.map((s) => (
        <section key={s.id} id={`guide-${s.id}`} className="guide-section">
          <h2>{s.title}</h2>
          <div className="card">{content[s.id]}</div>
        </section>
      ))}
    </div>
  );
}

function ActorBadges({ actors }: { actors: Actor[] }) {
  if (actors.length === 0) {
    return <Badge tone="muted">{t({ zh: '占位', en: 'Placeholder' })}</Badge>;
  }
  return (
    <>
      {actors.map((a) => (
        <Badge key={a} tone={ACTOR[a].tone}>
          {ACTOR[a].label}
        </Badge>
      ))}
    </>
  );
}

function Intro(props: {
  input: GuideInput;
  working: boolean;
  version: string | null;
  /** config.yaml has a `github` or a `gitlab` section. */
  hostEnabled: boolean;
}) {
  const { auto, you } = autonomy(props.input);
  const level = autonomyLevel(props.input.github);
  return (
    <>
      <p className="guide-lead">
        {t({
          zh: (
            <>
              <strong>{brandName()}</strong>——{brandSlogan()}。Master 按 workflow 调度 Agent（Claude
              Code 等）编码、评审、合并，并自己验收结果；现在它也用这套流程开发它自己。
            </>
          ),
          en: (
            <>
              <strong>{brandName()}</strong> — {brandSlogan()}. The Master schedules agents (Claude
              Code and others) along a workflow to code, review and merge, and checks the results
              itself; it now develops itself with the same flow.
            </>
          ),
        })}
      </p>
      <p>
        {t({
          zh: (
            <>
              需求以 GitHub 或 GitLab 上的 issue 的形式提出：可以是你写的，也可以是 AI
              读代码、文档和 Run 记录后提的。Master 把 issue 变成 Run
              一步步做完、合并，再把自己升级到新版本，然后去找下一件事。下面按
              <strong>当前配置</strong>说明哪些步骤它自己做、哪些由你来做；改了{' '}
              <code>config.yaml</code> 后这页会跟着变。
            </>
          ),
          en: (
            <>
              Requirements come as issues on GitHub or GitLab: written by you, or proposed by the AI
              after reading the code, the docs and past Runs. The Master turns an issue into a Run,
              works it through step by step and merges it, upgrades itself to the new version, then
              looks for the next thing. Below, by the <strong>current configuration</strong>, is
              which steps it does by itself and which are up to you; this page follows changes to{' '}
              <code>config.yaml</code>.
            </>
          ),
        })}
      </p>
      {!props.hostEnabled && (
        <p className="guide-now guide-now-wait">
          {t({
            zh: (
              <>
                还没有接入 GitHub 或 GitLab：这一页讲的循环靠 issue 转起来，在{' '}
                <code>config.yaml</code> 里加上 <code>github</code>（用 gh）或 <code>gitlab</code>
                （用 glab，gitlab.com 或自建的都行）配置后自动生效，示例见
                <a href={href.issues}>「需求」页</a>。两者都不接的仓库可以用本地提案池（
                <code>config.yaml</code> 的 <code>backlog</code>），同样能自己侦察、采纳、建
                Run，你也可以在「需求」页点「写需求」把自己要做的事写进去。
              </>
            ),
            en: (
              <>
                Neither GitHub nor GitLab is set up yet: the loop on this page runs on issues. Add a{' '}
                <code>github</code> section (through gh) or a <code>gitlab</code> section (through
                glab, gitlab.com or a self-hosted one) to <code>config.yaml</code> and it takes
                effect by itself; see the <a href={href.issues}>Issues page</a> for examples. Repos
                with neither can use the local backlog (<code>backlog</code> in{' '}
                <code>config.yaml</code>), which scouts, accepts and creates Runs by itself too; you
                can also write what you want done into it with "Write a requirement" on the Issues
                page.
              </>
            ),
          })}
        </p>
      )}
      <dl className="meta">
        <div>
          <dt>Master</dt>
          <dd>
            {props.working
              ? t({ zh: '工作中', en: 'Working' })
              : t({ zh: '已停工', en: 'Stopped' })}
            {props.version
              ? t({
                  zh: `（版本 ${shortSha(props.version)}）`,
                  en: ` (version ${shortSha(props.version)})`,
                })
              : ''}
          </dd>
        </div>
        {props.input.github && (
          <div>
            <dt>{t({ zh: '放权级别', en: 'Autonomy level' })}</dt>
            <dd>{level ?? '—'}</dd>
          </div>
        )}
        <div className="wide">
          <dt>{t({ zh: '它自己做的', en: 'Done by itself' })}</dt>
          <dd>{join(auto)}</dd>
        </div>
        <div className="wide">
          <dt>{t({ zh: '由你来做的', en: 'Up to you' })}</dt>
          <dd>
            {you.length > 0
              ? join(you)
              : t({
                  zh: '没有：全部交给它了，你只在收到通知时处理',
                  en: 'Nothing: everything is handed over; you only act when notified',
                })}
          </dd>
        </div>
      </dl>
    </>
  );
}

/** How a project is brought in from scratch on the dashboard: the Repos page's wizard, in order. */
function OnboardSection() {
  return (
    <>
      <p>
        {t({
          zh: (
            <>
              要让 Master 开发一个新项目，在<a href={href.repos}>「仓库」页</a>
              顶部点「接入新项目」。 向导按下面的顺序走，每一步都在看板上做完，不用手改配置文件：
            </>
          ),
          en: (
            <>
              To have the Master work on a new project, choose "Bring in a new project" at the top
              of the <a href={href.repos}>Repos page</a>. The wizard goes through these steps in
              order, each done on the dashboard without editing any configuration file by hand:
            </>
          ),
        })}
      </p>
      <ol className="guide-list">
        {ONBOARD_STEPS.map((step) => (
          <li key={step}>
            <strong>{onboardStepTitle(step)}</strong>
            {t({ zh: '：', en: ': ' })}
            {onboardStepSummary(step)}
          </li>
        ))}
      </ol>
      <p>
        {t({
          zh: (
            <>
              走完之后向导告诉你怎么开始：需求来自 GitHub 或 GitLab 的，给 issue 打上{' '}
              <code>ares1:ready</code> 标签；用本地提案池的，在<a href={href.issues}>「需求」页</a>
              的仓库卡片上点「写需求」。选了侦察 Agent 的，也可以在「需求」页点「让 AI
              找活」手动侦察，让 AI 读代码提需求。
            </>
          ),
          en: (
            <>
              At the end the wizard says how to start: with requirements from GitHub or GitLab,
              label an issue <code>ares1:ready</code>; with the local backlog, choose "Write a
              requirement" on the repo's card on the <a href={href.issues}>Issues page</a>. With a
              scout agent chosen, "Let the AI find work" on the Issues page also has the AI read the
              code and propose requirements.
            </>
          ),
        })}
      </p>
      <p className="muted">
        {t({
          zh: '登记好的仓库在中途关掉向导后照样留着，之后在仓库卡片上接着设置：「修改」里探测和改命令，「试运行」，需求来源后面的「设置」。每一步对应的 API 见 docs/running.md 的「接入新项目」。',
          en: 'A registered repo stays when the wizard is closed halfway; the rest can be set on its card later: Edit to detect and change the commands, Try the commands, and Set by its requirements. The API behind each step is in the section on bringing in a new project of docs/running.md.',
        })}
      </p>
    </>
  );
}

function CycleSection({ input }: { input: GuideInput }) {
  const steps = cycleSteps(input);
  const stages = runStages(input);
  const problems = input.github?.problems ?? [];
  return (
    <>
      <div className="guide-legend">
        {(Object.keys(ACTOR) as Actor[]).map((a) => (
          <Badge key={a} tone={ACTOR[a].tone}>
            {ACTOR[a].label}
          </Badge>
        ))}
        <span className="muted">
          {t({
            zh: 'AI：Agent 来做；Master 自动：Master 按规则直接做；由你来做：配置没交给它，要你动手',
            en: 'AI: an agent does it; Master (auto): the Master does it by its rules; Up to you: the configuration does not hand it over, so you do it',
          })}
        </span>
      </div>
      {problems.length > 0 && (
        <ErrorBox>
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </ErrorBox>
      )}
      <div className="cycle">
        <ol className="cycle-steps">
          {steps.map((step, i) => (
            <CycleStepItem
              key={step.id}
              n={i + 1}
              step={step}
              stages={step.id === 'run' ? stages : null}
            />
          ))}
        </ol>
        <div className="cycle-loop" aria-hidden="true">
          <span>{t({ zh: '回到第 1 步', en: 'Back to step 1' })}</span>
        </div>
      </div>
    </>
  );
}

function CycleStepItem(props: { n: number; step: CycleStep; stages: CycleStage[] | null }) {
  const { step, stages } = props;
  return (
    <li className={`cycle-step cycle-${step.actors[0] ?? 'none'}`}>
      <span className="cycle-num">{props.n}</span>
      <div className="cycle-body">
        <div className="cycle-head">
          <strong>{step.name}</strong>
          <ActorBadges actors={step.actors} />
        </div>
        <div className="cycle-text">{step.text}</div>
        {stages && (
          <ol className="cycle-stages" aria-label={t({ zh: 'Run 的阶段', en: 'Stages of a Run' })}>
            {stages.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 && <li className="cycle-arrow" aria-hidden="true" />}
                <li className="cycle-stage">
                  <span className="cycle-head">
                    <strong>{s.name}</strong>
                    <ActorBadges actors={s.actors} />
                  </span>
                  <span className="muted">{s.note}</span>
                </li>
              </Fragment>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

function ScoutSection({ input }: { input: GuideInput }) {
  const guide = scoutGuide(input);
  const hasConditions = guide.conditions.length > 0;
  const hostName = platformName(input.host.platform);
  return (
    <>
      {input.github && (
        <p>
          {t({
            zh: (
              <>
                Master 每 {input.pollMinutes} 分钟检查一次 {hostName}：把带 <code>ares1:ready</code>{' '}
                的 issue 建成 Run，补回写进展。
                {hasConditions && '自动侦察要下面的条件都满足：'}
              </>
            ),
            en: (
              <>
                Every {input.pollMinutes} minutes the Master checks {hostName}: it turns issues
                labeled <code>ares1:ready</code> into Runs and catches up on reporting progress.
                {hasConditions && ' An automatic scout needs all of these:'}
              </>
            ),
          })}
        </p>
      )}
      {hasConditions && (
        <ul className="guide-list">
          {guide.conditions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <p className={guide.waiting ? 'guide-now guide-now-wait' : 'guide-now'}>{guide.now}</p>
      {input.github?.scout && (
        <p className="muted">
          {t({
            zh: (
              <>
                手动侦察（<a href={href.issues}>「需求」页</a>的「让 AI
                找活」）不受这些条件限制。侦察是只读的，不改文件、不跑命令。
              </>
            ),
            en: (
              <>
                A manual scout ("Let the AI find work" on the <a href={href.issues}>Issues page</a>)
                ignores these conditions. Scouting is read-only: it changes no files and runs no
                commands.
              </>
            ),
          })}
        </p>
      )}
      <h3>{t({ zh: '迭代', en: 'Iterations' })}</h3>
      <ul className="guide-list">
        {iterationGuide().map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="muted">
        {t({
          zh: (
            <>
              每个迭代的目标、完成标准、进度、各步的状态、费用和用时在
              <a href={href.iterations}>「迭代」页</a>；首页列出没结束的迭代。
            </>
          ),
          en: (
            <>
              The goal, completion criteria, progress, the state of each step, cost and time of
              every iteration are on the <a href={href.iterations}>Iterations page</a>; the home
              page lists the iterations not over yet.
            </>
          ),
        })}
      </p>
    </>
  );
}

function YouSection(props: { input: GuideInput; home: string; working: boolean }) {
  const { input, home } = props;
  const issuesRepo = input.github?.issuesRepo ?? null;
  const upgrade = input.upgrade;
  const hostName = platformName(input.host.platform);
  const onGitLab = input.host.platform === 'gitlab';
  const newIssue = issuesRepo && (
    <a href={newIssueUrl(input.host, issuesRepo, 'ares1:ready')} target="_blank" rel="noreferrer">
      {t({ zh: '新建 issue', en: 'new issue' })}
    </a>
  );
  const proposals = issuesRepo && (
    <a href={issuesUrl(input.host, issuesRepo, 'ares1:proposal')} target="_blank" rel="noreferrer">
      {t({ zh: '待审提案', en: 'proposals to triage' })}
    </a>
  );
  const target = input.targetBranch && <code>{input.targetBranch}</code>;
  return (
    <div className="guide-items">
      <div>
        <h3>{t({ zh: '开机后启动 Master', en: 'Start the Master after booting' })}</h3>
        <p>
          {t({
            zh: (
              <>
                在稳定副本（Master 运行的那份代码，与开发仓库分开）里后台启动，输出追加到{' '}
                <code>master.out</code>：
              </>
            ),
            en: (
              <>
                Start it in the background from the stable copy (the code the Master runs, separate
                from the development repo), appending its output to <code>master.out</code>:
              </>
            ),
          })}
        </p>
        <Pre>{startCommand(upgrade.installDir, home)}</Pre>
        <p className="muted">
          {upgrade.installDir
            ? t({
                zh: '目录取自当前 Master 的安装目录。',
                en: "The directory is the current Master's install directory. ",
              })
            : t({
                zh: '当前 Master 不是从稳定副本的构建启动的（例如用 npm run dev），不能自动升级；把目录换成你的稳定副本。',
                en: 'The current Master was not started from the build of a stable copy (e.g. with npm run dev), so it cannot upgrade itself; put your stable copy there. ',
              })}
          {t({
            zh: '然后打开看板（就是这个页面）。关机前可以先点「停工」等正在执行的 Run 做完；直接关机也没关系，被打断的 Task 下次启动时从头重做。',
            en: 'Then open the dashboard (this page). Before shutting down you can stop work and let running Runs finish; shutting down right away is fine too: an interrupted Task is redone from the start next time.',
          })}
        </p>
      </div>
      <div>
        <h3>{t({ zh: '工作开关', en: 'The work switch' })}</h3>
        <p>
          {t({
            zh: `顶栏的「工作中 / 已停工」（现在：${props.working ? '工作中' : '已停工'}）。停工时排队的 Run 不开始，不从 issue 接活、不自动采纳、不自动侦察，也不自动升级；正在执行的 Run 会做完，想立刻停下就在 Run 详情页暂停它；issue 被你关闭的 Run 照样终止。开工后马上继续排队的 Run，并立即检查一次 GitHub 和 GitLab。状态存在数据库里，重启后保持。`,
            en: `"Working / Stopped" in the top bar (now: ${props.working ? 'working' : 'stopped'}). While stopped, queued Runs do not start, no issues are taken, nothing is accepted or scouted automatically and there are no automatic upgrades; running Runs finish (pause one on its page to stop it at once), and Runs whose issue you close are still cancelled. Once working again, queued Runs continue right away and GitHub and GitLab are checked at once. The state is kept in the database across restarts.`,
          })}
        </p>
      </div>
      <div>
        <h3>{t({ zh: '收到通知时', en: 'When notified' })}</h3>
        <p>
          {t({
            zh: (
              <>
                点通知会打开对应的 Run 或「需求」页；所有要你处理的 Run 都在
                <a href={href.home}>首页「待我处理」</a>。每种通知怎么处理见
                <a href={href.guideSection('notify')}>下面</a>。
              </>
            ),
            en: (
              <>
                Clicking a notification opens its Run or the Issues page; every Run that needs you
                is under <a href={href.home}>"Needs me" on the home page</a>. What to do about each
                kind of notification is <a href={href.guideSection('notify')}>below</a>.
              </>
            ),
          })}
        </p>
      </div>
      <div>
        <h3>{t({ zh: '给它提需求', en: 'Ask it for something' })}</h3>
        <p>
          {t({
            zh: (
              <>
                在 {hostName} 上写 issue，加上 <code>ares1:ready</code> 标签
                {newIssue && <>（{newIssue}）</>}，
                {input.github
                  ? `Master 每 ${input.pollMinutes} 分钟查一次`
                  : '接入 GitHub 或 GitLab 后 Master 会定时查看'}
                ，工作中时就建 Run。写清楚为什么、要做什么和验收标准，Agent
                就照着做。开工后、合并之前想改需求，直接改 issue 的标题或正文，Master
                下次检查时终止旧 Run，按新内容重来。看板不提供手动建 Run：接了 GitHub 或 GitLab
                的仓库，需求只从那里的 issue 来；用本地提案池的仓库在
                <a href={href.issues}>「需求」页</a>
                点「写需求」，马上开工或先存着；等你决定的提案可以先点「修改」改好再采纳。
              </>
            ),
            en: (
              <>
                Write an issue on {hostName} and label it <code>ares1:ready</code>
                {newIssue && <> ({newIssue})</>}.{' '}
                {input.github
                  ? `The Master checks every ${input.pollMinutes} minutes`
                  : 'Once GitHub or GitLab is set up, the Master checks regularly'}{' '}
                and creates a Run while working. Say why, what to do and how to tell it is done, and
                the agents follow it. To change the requirement after work started, before it
                merges, just edit the issue's title or body: at its next check the Master cancels
                the old Run and starts over on the new text. The dashboard does not create Runs by
                hand: for a repo on GitHub or GitLab, requirements only come from its issues there;
                for a repo using the local backlog, click "Write a requirement" on the{' '}
                <a href={href.issues}>Issues page</a> to start it at once or keep it for later; a
                proposal waiting for you can be edited first, then accepted.
              </>
            ),
          })}
        </p>
      </div>
      <div>
        <h3>{t({ zh: '拒绝提案', en: 'Reject a proposal' })}</h3>
        <p>
          {t({
            zh: (
              <>
                不想做的 <code>ares1:proposal</code>
                {proposals && <>（{proposals}）</>}：
                {onGitLab ? (
                  <>
                    GitLab 关闭 issue 时不带原因，所以关闭的同时要加上{' '}
                    <code>ares1:not-planned</code>{' '}
                    标签，并留一句理由（比如评论第一行写理由，下面两行写{' '}
                    <code>/label ~"ares1:not-planned"</code> 和 <code>/close</code>
                    ）；只关闭不加标签会被当成已经做完。
                  </>
                ) : (
                  <>
                    在 GitHub 上关闭为 <strong>not planned</strong>，并留一句理由。
                  </>
                )}
                侦察下次会把它当作反例，不再提类似的。已经开工的（例如自动采纳的）也会在 Master
                下次检查时一并终止，Master 不再在这个 issue 上留言或改标签。
              </>
            ),
            en: (
              <>
                For an <code>ares1:proposal</code> you do not want
                {proposals && <> ({proposals})</>}:{' '}
                {onGitLab ? (
                  <>
                    GitLab closes an issue without a reason, so close it with the{' '}
                    <code>ares1:not-planned</code> label and a one-line reason (say, a comment with
                    the reason on its first line, then <code>/label ~"ares1:not-planned"</code> and{' '}
                    <code>/close</code> on lines of their own); closed without the label, it counts
                    as done.
                  </>
                ) : (
                  <>
                    close it on GitHub as <strong>not planned</strong> with a one-line reason.
                  </>
                )}{' '}
                The next scout takes it as a counterexample and does not propose anything like it
                again. If work has already started (e.g. it was auto-accepted), the Run is cancelled
                at the Master's next check, and the Master no longer comments on or relabels the
                issue.
              </>
            ),
          })}
        </p>
      </div>
      <div>
        <h3>{t({ zh: '调整方向', en: 'Change direction' })}</h3>
        <p>
          {t({
            zh: (
              <>
                改 <code>README.md</code> 里的目标（一切决定的依据）和 <code>AGENTS.md</code>，
                提交到目标分支
                {target && <>（{target}）</>}
                。侦察每次都先读它们来判断该做什么，编码和评审的 Agent 也照着它们做。
              </>
            ),
            en: (
              <>
                Change the goals in <code>README.md</code> (the basis for every decision) and{' '}
                <code>AGENTS.md</code>, and commit them to the target branch
                {target && <> ({target})</>}. The scout reads them first every time to decide what
                to do, and the coding and review agents follow them too.
              </>
            ),
          })}
        </p>
      </div>
    </div>
  );
}

function NotifySection({
  systemNotify,
  webhookNotify,
}: {
  systemNotify: boolean;
  webhookNotify: boolean;
}) {
  return (
    <>
      <p>
        {t({
          zh: '只在需要你做点什么时通知；Run 完成、侦察完成都已自动处理，不通知。',
          en: 'You are notified only when you need to do something; finished Runs and scouts are handled automatically and do not notify.',
        })}
      </p>
      <p className="guide-now">{notifyChannel(systemNotify, webhookNotify)}</p>
      <NotifyTest systemNotify={systemNotify} webhookNotify={webhookNotify} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t({ zh: '通知', en: 'Notification' })}</th>
              <th>{t({ zh: '什么时候', en: 'When' })}</th>
              <th>{t({ zh: '怎么处理', en: 'What to do' })}</th>
            </tr>
          </thead>
          <tbody>
            {noticeRows().map((row) => (
              <tr key={row.kind}>
                <td className="guide-nowrap">{row.label}</td>
                <td>{row.when}</td>
                <td>{row.handle}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Sends a test notification through the Master's channels and shows how each went. */
function NotifyTest({
  systemNotify,
  webhookNotify,
}: {
  systemNotify: boolean;
  webhookNotify: boolean;
}) {
  const action = useAction();
  const [result, setResult] = useState<NotifyTestResult>();
  const unavailable = notifyTestUnavailable(systemNotify, webhookNotify);
  return (
    <div className="guide-notify-test">
      <div className="issues-poll">
        <button
          type="button"
          disabled={action.busy || unavailable !== null}
          onClick={async () => {
            setResult(undefined);
            const sent = await action.run(() => api.notifyTest());
            if (sent) setResult(sent);
          }}
        >
          {action.busy
            ? t({ zh: '发送中…', en: 'Sending…' })
            : t({ zh: '发一条测试通知', en: 'Send a test notification' })}
        </button>
        {unavailable && <span className="muted">{unavailable}</span>}
      </div>
      {result && (
        <ul className="guide-notify-results">
          {notifyTestLines(result).map((line) => (
            <li key={line.channel}>
              <Badge tone={line.tone}>{line.label}</Badge>
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      )}
      <ErrorBox>{action.error}</ErrorBox>
    </div>
  );
}

function LabelsSection({ autoAccept }: { autoAccept: GitHubRepoStatus['autoAccept'] | null }) {
  return (
    <>
      <p>
        {t({
          zh: (
            <>
              Master 第一次访问仓库时自动创建这些标签。<code>ares1:ready</code>、
              <code>ares1:running</code>、<code>ares1:needs-you</code>、<code>ares1:failed</code>{' '}
              是状态标签，同一时间只保留一个；其他标签（包括仓库自己的）不动。
            </>
          ),
          en: (
            <>
              The Master creates these labels the first time it uses a repo.{' '}
              <code>ares1:ready</code>, <code>ares1:running</code>, <code>ares1:needs-you</code> and{' '}
              <code>ares1:failed</code> are status labels, only one at a time; other labels
              (including the repo's own) are left alone.
            </>
          ),
        })}
      </p>
      <dl className="meta">
        {labelHelp(autoAccept).map(([label, text]) => (
          <div key={label} className="wide">
            <dt>
              <code>{label}</code>
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function GuardsSection({ input, working }: { input: GuideInput; working: boolean }) {
  return (
    <>
      <p>
        {t({
          zh: '即使全部交给它，下面这些仍然把关：',
          en: 'Even with everything handed over, these still stand guard:',
        })}
      </p>
      <ul className="guide-guards">
        {guardrails(input, working).map((g) => (
          <li key={g.title}>
            <span className="guide-guard-head">
              <strong>{g.title}</strong>
              <Badge tone={g.on ? 'success' : 'muted'}>
                {g.on ? t({ zh: '生效中', en: 'On' }) : t({ zh: '没开', en: 'Off' })}
              </Badge>
            </span>
            <span>{g.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Delivering through pull requests, for repos whose target branch is protected: deliver: pr on
 * GitHub, deliver: mr (merge requests) on GitLab, the code host of the repo the guide is about
 * (`platform`).
 */
function PullRequestFaq({
  github,
  platform,
}: {
  github: GitHubRepoStatus | null;
  platform: HostPlatform;
}) {
  const { host, short, long, deliver } = changeRequestTerms(platform);
  const gitlab = platform === 'gitlab';
  const section = gitlab ? 'gitlab' : 'github';
  return (
    <div>
      <h3>
        {t({
          zh: `目标分支受保护、只能走 ${short} 怎么办？`,
          en: `What if the target branch is protected and only takes ${long}s?`,
        })}
      </h3>
      {github && (
        <p className="guide-now">
          {t({ zh: '现在：', en: 'Now: ' })}
          {deliveryText(github)}
        </p>
      )}
      <p>
        {t({
          zh: (
            <>
              在 <code>config.yaml</code> 的 <code>{section}.repos.&lt;仓库名&gt;</code> 里写{' '}
              <code>deliver: {deliver}</code>（要同时配 <code>push: true</code>
              ，不然这个仓库停用），保存后生效。 {host} 上的
              {gitlab ? '流水线、评审和审批' : ' CI 和评审'}照常起作用：
            </>
          ),
          en: (
            <>
              Set <code>deliver: {deliver}</code> under{' '}
              <code>{section}.repos.&lt;repo name&gt;</code> in <code>config.yaml</code> (with{' '}
              <code>push: true</code>, or the repo is disabled); it takes effect when saved.{' '}
              {gitlab ? 'Pipelines, reviews and approvals' : 'CI and reviews'} on {host} work as
              usual:
            </>
          ),
        })}
      </p>
      <Pre>{`${section}:\n  repos:\n    my-repo:\n      push: true\n      deliver: ${deliver}`}</Pre>
      <ul className="guide-list">
        <li>
          {t({
            zh: `合并阶段照常把目标分支的新提交合进 Run 的分支、跑检查，但不动本地的目标分支；Master 下次检查 ${host} 时推送 Run 的分支（ares1/ 开头，会强制推送），开一个合并到目标分支的 ${short}（已经有开着的就接着用），正文用 Closes 关联 issue。`,
            en: `The merge stage still merges the target branch's new commits into the Run's branch and runs the checks, but leaves the local target branch alone; at its next ${host} check the Master pushes the Run's branch (ares1/…, force-pushed) and opens a ${long} into the target branch (or keeps using one already open), linked to the issue with Closes.`,
          })}
        </li>
        <li>
          {t({
            zh: `Run 随后进入「${blockKindText('pr_open', platform)}」：不占执行名额，没有可以重试的，不算卡住，Master 重启后由每轮检查接着等。`,
            en: `The Run then shows "${blockKindText('pr_open', platform)}": it takes no execution slot, has nothing to retry and is not stuck; after a Master restart each check goes on waiting.`,
          })}
        </li>
        <li>
          {gitlab
            ? t({
                zh: 'MR 在 GitLab 上合并后（合并方式不限），Master 把本地的目标分支快进到 GitLab 上的提交，Run 完成、issue 关闭（GitLab 没自动关 issue 时 Master 自己关）。',
                en: 'Once the merge request is merged on GitLab (by whichever merge method), the Master fast-forwards the local target branch to GitLab’s, the Run completes and the issue is closed (by the Master when GitLab does not close it).',
              })
            : t({
                zh: 'PR 在 GitHub 上合并后（merge、squash、rebase 都行），Master 把本地的目标分支快进到 GitHub 上的提交，Run 完成、issue 关闭。',
                en: 'Once the pull request is merged on GitHub (by a merge, a squash or a rebase), the Master fast-forwards the local target branch to GitHub’s, the Run completes and the issue is closed.',
              })}
        </li>
        <li>
          {t({
            zh: `${short} 没合并就被关掉时，Run 结束为失败并通知你；还有重做次数（max_run_attempts）时 issue 自动重做，重做的 Run 开新的 ${short}。Run 没做完就结束（失败、被终止，或因 issue 被关掉、内容改了而终止）时，Master 下次检查 ${host} 时关掉它还开着的 ${short}，并在 ${short} 上说明原因，所以一个 issue 同时只有一个开着的 ${short}；已经合并的 ${short} 不动。`,
            en: `If the ${long} is closed unmerged, the Run ends as failed and you are notified; while attempts remain (max_run_attempts) the issue is redone, and the new Run opens a new ${long}. When a Run ends unfinished (it failed, was cancelled, or was terminated because its issue was closed or changed), the Master closes the ${long} it left open at its next ${host} check and says why on it, so an issue has one open ${long} at a time; one already merged is left alone.`,
          })}
        </li>
        <li>
          {t({
            zh: '这样的仓库，Master 从不推送目标分支。',
            en: 'For such a repo the Master never pushes the target branch.',
          })}
        </li>
      </ul>
    </div>
  );
}

function FaqSection(props: { input: GuideInput; home: string; idle: string[] }) {
  const { input, home } = props;
  const { github } = input;
  const leftToYou = github && acceptRanges(github.autoAccept).human;
  return (
    <div className="guide-items">
      <div>
        <h3>{t({ zh: '为什么一直没开始新的 Run？', en: 'Why does no new Run start?' })}</h3>
        {props.idle.length > 0 ? (
          <div className="guide-now guide-now-wait">
            {t({ zh: '现在：', en: 'Now:' })}
            <ul className="guide-list">
              {props.idle.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="guide-now">
            {t({ zh: '现在没发现挡着的原因。', en: 'Nothing is in the way right now.' })}
          </p>
        )}
        <p>{t({ zh: '常见原因：', en: 'Common reasons:' })}</p>
        <ul className="guide-list">
          <li>
            {t({
              zh: '停工了：顶栏显示「已停工」，点一下开工。',
              en: 'Work is stopped: the top bar says "Stopped"; click it to start working.',
            })}
          </li>
          <li>
            {t({
              zh: '在等 Master 升级：发现新版本后先做完手上的工作，不开始新的（「需求」页能看到升级状态）。',
              en: 'Waiting for a Master upgrade: once a new version is found, it finishes the work at hand and starts nothing new (the Issues page shows the upgrade status).',
            })}
          </li>
          <li>
            {t({
              zh: '前面有 Run 卡住或在等审批：它们不算在正在执行的 Run 里（每个仓库最多同时执行 concurrency.per_repo 个），排队的 Run 照常执行，也不挡自动侦察；但它们和等你处理的提案一起计入 max_proposals，攒满后不再自动侦察，也就没有新的提案和 Run。到首页「待我处理」处理它，或者终止它。',
              en: 'A Run is blocked or waiting for approval: it does not count among the executing Runs (up to concurrency.per_repo per repo), so queued Runs still execute and the automatic scout goes on; but such Runs count toward max_proposals together with the proposals waiting for you, and once that is reached the repo is not scouted automatically, so no new proposals or Runs come. Handle it under "Needs me" on the home page, or cancel it.',
            })}
          </li>
          <li>
            {github && github.autoAccept.maxRisk !== 'none'
              ? leftToYou
                ? t({
                    zh: `提案在等你采纳：${leftToYou}要你加 ares1:ready，它们不挡侦察，系统照常找活；在自动采纳范围内的提案因为当天的自动采纳数已满而攒多了时，才不再侦察。`,
                    en: `Proposals are waiting for you: ${leftToYou} need you to add ares1:ready, but they do not hold the scout back and it keeps finding work; it stops scouting only when proposals within the auto-accept range pile up because the auto-accept count for the day is used up.`,
                  })
                : t({
                    zh: '提案攒多了：所有提案都自动采纳，不用你处理；只有当天的自动采纳数已满、提案攒多了时才不再侦察，第二天自动采纳积压的提案后恢复。',
                    en: 'Proposals pile up: every proposal is accepted automatically, so none waits for you; it stops scouting only when proposals pile up because the auto-accept count for the day is used up, and resumes once the backlog is accepted the next day.',
                  })
              : t({
                  zh: '提案在等你采纳：现在所有提案都要你加 ares1:ready；未处理的提案太多时也不会再侦察。',
                  en: 'Proposals are waiting for you: every proposal needs you to add ares1:ready now; with too many untriaged proposals it does not scout either.',
                })}
          </li>
          {github && github.budget.dailyUsd !== null && (
            <li>
              {t({
                zh: '今天的自动花费到了上限：当天不再自动侦察、自动采纳和自动重做失败的 Run，第二天恢复。',
                en: "Today's automatic spending hit the limit: no automatic scouting, accepting or redoing of failed Runs for the rest of the day; it resumes the next day.",
              })}
            </li>
          )}
        </ul>
      </div>
      <div>
        <h3>{t({ zh: 'Run 卡住了怎么办？', en: 'What if a Run is blocked?' })}</h3>
        <p>
          {t({
            zh: `打开 Run 详情看原因和具体问题，可能是：${join(blockReasons())}。`,
            en: `Open the Run to see the reason and the details; it can be: ${join(blockReasons())}.`,
          })}
        </p>
        <p>
          {t({
            zh: `其中「${BLOCK_KIND.task_failed}」和「${BLOCK_KIND.max_loops}」只在模板配置 on_exhausted: human 时卡住等人；默认（on_exhausted: fail）Run 直接结束、标为失败，从 issue 来的会带着失败原因自动重做，不挡后面的工作。Agent 出错也一样，只在 on_agent_error: human 时卡住；「${BLOCK_KIND.budget}」只在 on_budget_exceeded: pause 时卡住。处理方式：`,
            en: `Of these, "${BLOCK_KIND.task_failed}" and "${BLOCK_KIND.max_loops}" wait for a human only when the template sets on_exhausted: human; by default (on_exhausted: fail) the Run ends as failed, and a Run from an issue is redone with the reason it failed, holding nothing up. Agent errors likewise wait only with on_agent_error: human, and "${BLOCK_KIND.budget}" only with on_budget_exceeded: pause. What to do:`,
          })}
        </p>
        <ul className="guide-list">
          <li>
            {t({
              zh: '重试当前 Task：返工次数和出错后的自动重试次数都重新算，排到队首；可以换 Agent，附一段说明作为提示。',
              en: 'Retry the current Task: the rework count and the automatic retries after errors start over, and it goes to the front of the queue; you can switch the agent and add a note as a hint.',
            })}
          </li>
          <li>
            {t({
              zh: '超出预算：填一个更高的预算后继续，从停下的地方接着做。',
              en: 'Over budget: enter a higher budget and continue from where it stopped.',
            })}
          </li>
          <li>
            {t({
              zh: (
                <>
                  不想要了就终止：工作目录和分支保留，方便查看，在
                  <a href={href.workspaces}>「工作区」</a>页清理。
                </>
              ),
              en: (
                <>
                  No longer wanted, cancel it: the working directory and branch are kept for a look
                  and cleaned up on the <a href={href.workspaces}>Workspaces</a> page.
                </>
              ),
            })}
          </li>
        </ul>
      </div>
      <PullRequestFaq github={github} platform={input.host.platform} />
      <div>
        <h3>{t({ zh: '怎么让它完全停下来？', en: 'How do I stop it completely?' })}</h3>
        <ul className="guide-list">
          <li>
            {t({
              zh: '顶栏「停工」：不再开始新的工作，正在执行的做完。',
              en: 'Stop work in the top bar: nothing new starts, what is running finishes.',
            })}
          </li>
          <li>
            {t({
              zh: '要立刻停下正在执行的 Run：在 Run 详情页暂停（丢弃未提交的改动，恢复后重做这个 Task）。',
              en: 'To stop a running Run at once: pause it on its page (uncommitted changes are dropped; the Task is redone when resumed).',
            })}
          </li>
          <li>
            {t({
              zh: '停掉 Master 进程：前台运行时按 Ctrl+C；按上面的命令后台启动的，用下面的命令。Master 会先停掉正在执行的 Agent 再退出，下次启动时被打断的 Run 排到队首重做。',
              en: 'Stop the Master process: Ctrl+C when it runs in the foreground; started in the background with the command above, use the command below. The Master stops running agents before it exits, and interrupted Runs go to the front of the queue on the next start.',
            })}
          </li>
        </ul>
        <Pre>{stopCommand(home)}</Pre>
        <p className="muted">
          {t({
            zh: (
              <>
                只想收回放权：在 <code>config.yaml</code> 里把 <code>auto_accept.max_risk</code>{' '}
                设为 <code>none</code>、<code>scout.auto</code>、<code>auto_merge</code>、
                <code>push</code>、<code>upgrade.auto</code> 设为 <code>false</code>
                ，保存后自动生效。
              </>
            ),
            en: (
              <>
                To just take back control: in <code>config.yaml</code> set{' '}
                <code>auto_accept.max_risk</code> to <code>none</code> and <code>scout.auto</code>,{' '}
                <code>auto_merge</code>, <code>push</code> and <code>upgrade.auto</code> to{' '}
                <code>false</code>; it takes effect when saved.
              </>
            ),
          })}
        </p>
      </div>
      <div>
        <h3>{t({ zh: '数据和日志在哪？', en: 'Where are the data and logs?' })}</h3>
        <p>
          {t({
            zh: (
              <>
                都在数据目录 <code>{home}</code> 里，不在任何仓库中，Agent 正常工作时碰不到：
              </>
            ),
            en: (
              <>
                All in the data directory <code>{home}</code>, outside any repo, so agents do not
                touch them in normal work:
              </>
            ),
          })}
        </p>
        <dl className="meta">
          {dataPaths(home).map((p) => (
            <div key={p.path} className="wide">
              <dt>
                <code>{p.path}</code>
              </dt>
              <dd>{p.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
