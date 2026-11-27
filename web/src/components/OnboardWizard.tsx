import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ConfigView, RepoDetection } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import { api } from '../lib/api.js';
import { repoSourceOf } from '../lib/config.js';
import { parseLines } from '../lib/format.js';
import { useAction } from '../lib/hooks.js';
import {
  backToStepLabel,
  commandsWarning,
  detectsOnEntry,
  type OnboardEnd,
  type OnboardState,
  type OnboardStep,
  onboardBack,
  onboardCloseNote,
  onboardDoneLead,
  onboardMarkLabel,
  onboardNext,
  onboardNextSteps,
  onboardReminders,
  onboardStart,
  onboardStepHeading,
  onboardStepSummary,
  onboardSteps,
  sourceStepNote,
  trialFailure,
  trialKindLabel,
  trialOutcome,
  trialStepView,
} from '../lib/onboard.js';
import {
  detectedBox,
  detectLabel,
  serveFormInit,
  serveFormProblems,
  serveInput,
  serveLabel,
  setupLabel,
  trialHint,
  verifyLabel,
} from '../lib/repos.js';
import { href } from '../lib/router.js';
import {
  CommandList,
  CommandsFields,
  DetectionNote,
  detectHint,
  RegisterForm,
  ServeFields,
  ServeView,
  SourceSettings,
  TrialResult,
  useTrial,
} from './RepoForms.js';
import { Badge, ErrorBox } from './ui.js';

/**
 * The Repos page's wizard that brings a new project in: register the repo, fill in and save its
 * commands and service, try them, set where its requirements come from, then what to do next.
 * Each step saves as it goes, through the same APIs as the repo cards; closing it halfway undoes
 * nothing.
 * `config`: the configuration in use (reloaded by the app after `onChanged`).
 */
export function OnboardWizard(props: {
  config: ConfigView | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<OnboardState>(onboardStart);
  const [repo, setRepo] = useState<Repo>();
  // The configuration the Master answered the source step with, until the app has reloaded its
  // own (`over`: the app's then), so the last page shows the source just saved at once.
  const [saved, setSaved] = useState<{ view: ConfigView; over: ConfigView | undefined }>();
  const config = saved && saved.over === props.config ? saved.view : props.config;
  const next = (how: OnboardEnd = 'done') => setState((s) => onboardNext(s, how));
  const back = (step: OnboardStep) => setState((s) => onboardBack(s, step));
  const closeNote = onboardCloseNote(state.at);

  return (
    <section className="card onboard">
      <div className="onboard-head">
        <h2>{t({ zh: '接入新项目', en: 'Bring in a new project' })}</h2>
        {repo && <code className="muted">{repo.name}</code>}
        <button type="button" className="link onboard-close" onClick={props.onClose}>
          {t({ zh: '关闭向导', en: 'Close the wizard' })}
        </button>
      </div>
      {closeNote && <p className="hint">{closeNote}</p>}
      <ol className="onboard-steps">
        {onboardSteps(state).map((item) => {
          const label = (
            <>
              <span className="onboard-num">{item.mark === 'done' ? '✓' : item.n}</span>
              {item.title}
              {item.mark === 'skipped' && (
                <Badge tone="attention">{onboardMarkLabel('skipped')}</Badge>
              )}
            </>
          );
          return (
            <li
              key={item.step}
              className={`onboard-step onboard-${item.mark}`}
              title={onboardMarkLabel(item.mark)}
              aria-current={item.mark === 'current' ? 'step' : undefined}
            >
              {item.canGoBack ? (
                <button type="button" className="link" onClick={() => back(item.step)}>
                  {label}
                </button>
              ) : (
                label
              )}
            </li>
          );
        })}
      </ol>
      {state.at !== 'done' && (
        <div className="onboard-lead">
          <h3>{onboardStepHeading(state.at)}</h3>
          <p className="hint">{onboardStepSummary(state.at)}</p>
        </div>
      )}

      {state.at === 'register' && (
        <RegisterForm
          className="form"
          commands={false}
          onAdded={(registered) => {
            setRepo(registered);
            props.onChanged();
            next();
          }}
        />
      )}
      {repo && state.at === 'commands' && (
        <CommandsStep
          repo={repo}
          onSaved={(updated) => {
            setRepo(updated);
            props.onChanged();
            next();
          }}
        />
      )}
      {repo && state.at === 'trial' && (
        <TrialStep repo={repo} onBack={() => back('commands')} onNext={next} />
      )}
      {repo && state.at === 'source' && (
        <SourceStep
          repo={repo}
          config={config}
          onSaved={(view) => {
            setSaved({ view, over: props.config });
            props.onChanged();
            next();
          }}
          onSkip={() => next('skipped')}
        />
      )}
      {repo && state.at === 'done' && (
        <DonePage
          repo={repo}
          config={config}
          trial={state.ended.trial}
          onBack={back}
          onClose={props.onClose}
          onAgain={() => {
            setState(onboardStart());
            setRepo(undefined);
            setSaved(undefined);
          }}
        />
      )}
    </section>
  );
}

/**
 * Step 2: the commands and the service, detected from the project files as the step opens while
 * the repo has none saved, then checked, changed and saved by the human. The suggested start
 * command waits by the service boxes until the human adopts it.
 */
function CommandsStep(props: { repo: Repo; onSaved: (repo: Repo) => void }) {
  const { repo } = props;
  const [verify, setVerify] = useState(repo.verifyCommands.join('\n'));
  const [setup, setSetup] = useState(repo.setupCommands.join('\n'));
  const [serve, setServe] = useState(() => serveFormInit(repo.serve));
  const [detection, setDetection] = useState<RepoDetection>();
  const [auto] = useState(() => detectsOnEntry(repo));
  const detecting = useAction();
  const saving = useAction();
  const serveProblems = serveFormProblems(serve);
  const runDetect = detecting.run;
  // Fills the command boxes only (a box without a suggestion keeps what is in it), never the
  // service's; saving is the human's.
  const detect = useCallback(async () => {
    const found = await runDetect(() => api.detectRepo(repo.id));
    if (!found) return;
    setVerify((typed) => detectedBox(found.verify, typed));
    setSetup((typed) => detectedBox(found.setup, typed));
    setDetection(found);
  }, [runDetect, repo.id]);
  useEffect(() => {
    if (auto) void detect();
  }, [auto, detect]);

  const warning = commandsWarning(verify);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (serveProblems.length > 0) return;
    const updated = await saving.run(() =>
      api.updateRepo(repo.id, {
        verifyCommands: parseLines(verify),
        setupCommands: parseLines(setup),
        serve: serveInput(serve),
      }),
    );
    if (updated) props.onSaved(updated);
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="detect">
        <div className="detect-row">
          <button type="button" onClick={detect} disabled={detecting.busy || saving.busy}>
            {detectLabel(detecting.busy)}
          </button>
          <span className="hint">{detectHint(repo.targetBranch)}</span>
        </div>
        <ErrorBox>{detecting.error}</ErrorBox>
        {detection && <DetectionNote detection={detection} />}
      </div>
      <CommandsFields verify={verify} setup={setup} onVerify={setVerify} onSetup={setSetup} />
      {warning && <p className="hint text-attention">{warning}</p>}
      <ServeFields
        value={serve}
        onChange={setServe}
        disabled={saving.busy}
        suggestion={detection?.serve}
      />
      <ErrorBox>{saving.error}</ErrorBox>
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={saving.busy || detecting.busy || serveProblems.length > 0}
        >
          {saving.busy
            ? t({ zh: '保存中…', en: 'Saving…' })
            : t({ zh: '保存，下一步', en: 'Save and go on' })}
        </button>
      </div>
    </form>
  );
}

/**
 * Step 3: tries the commands and the service saved in step 2. On it goes once they pass; when
 * they fail it says which command (or the service) and why, and goes back to step 2 to change
 * them; it can be skipped, with what that risks.
 */
function TrialStep(props: { repo: Repo; onBack: () => void; onNext: (how?: OnboardEnd) => void }) {
  const { repo } = props;
  const trial = useTrial(repo.id);
  const outcome = trialOutcome(trial.trial, repo);
  const view = trialStepView(outcome, trial.busy);
  const shown = outcome === 'none' ? null : trial.trial;
  const failure = shown && outcome === 'failed' ? trialFailure(shown) : null;
  return (
    <div className="onboard-trial">
      <dl className="meta">
        <div className="wide">
          <dt>{setupLabel()}</dt>
          <dd>
            <CommandList commands={repo.setupCommands} />
          </dd>
        </div>
        <div className="wide">
          <dt>{verifyLabel()}</dt>
          <dd>
            <CommandList commands={repo.verifyCommands} />
          </dd>
        </div>
        <div className="wide">
          <dt>{serveLabel()}</dt>
          <dd>
            <ServeView serve={repo.serve} />
          </dd>
        </div>
      </dl>
      <div className="detect-row">
        <button
          type="button"
          className={view.canContinue ? undefined : 'btn-primary'}
          disabled={!view.canStart}
          onClick={() =>
            // What was saved in step 2, the service included: none when it has no start command.
            trial.start({
              setupCommands: repo.setupCommands,
              verifyCommands: repo.verifyCommands,
              serve: repo.serve,
            })
          }
        >
          {view.startLabel}
        </button>
        <span className="hint">{trialHint(repo.targetBranch, false)}</span>
      </div>
      <ErrorBox>{trial.error}</ErrorBox>
      {shown && <TrialResult trial={shown} now={trial.now} />}
      {failure && (
        <div className="onboard-failure" role="alert">
          <p>
            {failure.command && failure.kind ? (
              <>
                {trialKindLabel(failure.kind)} <code>{failure.command}</code> {failure.reason}
              </>
            ) : (
              failure.reason
            )}
          </p>
          <p>{failure.advice}</p>
        </div>
      )}
      <p className="hint">{view.note}</p>
      <div className="form-actions">
        <button
          type="button"
          className={view.canContinue ? 'btn-primary' : undefined}
          disabled={!view.canContinue}
          onClick={() => props.onNext()}
        >
          {t({ zh: '下一步', en: 'Next' })}
        </button>
        <button type="button" onClick={props.onBack}>
          {t({
            zh: '回到第 2 步改命令和服务',
            en: 'Back to step 2 to change the commands or service',
          })}
        </button>
        {view.skipWarning && (
          <button type="button" onClick={() => props.onNext('skipped')}>
            {t({ zh: '跳过试运行', en: 'Skip the trial' })}
          </button>
        )}
      </div>
      {view.skipWarning && <p className="hint text-attention">{view.skipWarning}</p>}
    </div>
  );
}

/** Step 4: where the requirements come from, the repo card's form; it can be skipped. */
function SourceStep(props: {
  repo: Repo;
  config: ConfigView | undefined;
  onSaved: (view: ConfigView) => void;
  onSkip: () => void;
}) {
  const { repo, config } = props;
  if (!config) {
    return (
      <>
        <ErrorBox>
          {t({
            zh: '配置还没读到，现在设置不了需求来源。可以先跳过，以后在仓库卡片上设置。',
            en: 'The configuration has not been read, so requirements cannot be set now. Skip, and set them on the repo card later.',
          })}
        </ErrorBox>
        <div className="form-actions">
          <button type="button" onClick={props.onSkip}>
            {t({ zh: '跳过', en: 'Skip' })}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="hint">{sourceStepNote(repoSourceOf(config, repo.name))}</p>
      <SourceSettings
        repo={repo}
        config={config}
        heading={false}
        onSaved={props.onSaved}
        onCancel={props.onSkip}
        cancelLabel={t({ zh: '跳过', en: 'Skip' })}
      />
    </>
  );
}

function BackButton(props: { step: OnboardStep; onBack: (step: OnboardStep) => void }) {
  return (
    <button type="button" className="link" onClick={() => props.onBack(props.step)}>
      {backToStepLabel(props.step)}
    </button>
  );
}

/** The last page: what to see to still, and how to get the first requirement done. */
function DonePage(props: {
  repo: Repo;
  config: ConfigView | undefined;
  trial: OnboardEnd | undefined;
  onBack: (step: OnboardStep) => void;
  onClose: () => void;
  onAgain: () => void;
}) {
  const { repo, config } = props;
  const source = config ? repoSourceOf(config, repo.name) : null;
  const reminders = onboardReminders({ repo, trial: props.trial, source });
  const steps = onboardNextSteps(repo.name, source);
  return (
    <div className="onboard-finish">
      <h3>{onboardDoneLead(repo.name, source)}</h3>
      {steps.length > 0 && (
        <ol className="guide-list">
          {steps.map((s) => (
            <li key={s.text}>
              {s.text}{' '}
              {s.link &&
                (s.link.external ? (
                  <a href={s.link.href} target="_blank" rel="noreferrer">
                    {s.link.label}
                  </a>
                ) : (
                  <a href={s.link.href}>{s.link.label}</a>
                ))}
              {s.back && <BackButton step={s.back} onBack={props.onBack} />}
            </li>
          ))}
        </ol>
      )}
      {reminders.length > 0 && (
        <ul className="onboard-reminders">
          {reminders.map((r) => (
            <li key={r.step}>
              {r.text} <BackButton step={r.step} onBack={props.onBack} />
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        {t({
          zh: (
            <>
              这些设置之后都能在下面的仓库卡片上改；整个流程怎么转见
              <a href={href.guideSection('onboard')}>「说明」页</a>。
            </>
          ),
          en: (
            <>
              All of this can be changed on the repo's card below later; how the whole flow goes is
              in the <a href={href.guideSection('onboard')}>Guide</a>.
            </>
          ),
        })}
      </p>
      <div className="form-actions">
        <button type="button" className="btn-primary" onClick={props.onClose}>
          {t({ zh: '完成', en: 'Finish' })}
        </button>
        <button type="button" onClick={props.onAgain}>
          {t({ zh: '再接入一个项目', en: 'Bring in another project' })}
        </button>
      </div>
    </div>
  );
}
