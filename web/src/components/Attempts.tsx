import type { FailedAttempt } from '../../../src/store/types.js';
import { api } from '../lib/api.js';
import { messageExcerpt } from '../lib/format.js';
import { useAction } from '../lib/hooks.js';
import { failureLabels, failuresHeading, restartLabels } from '../lib/proposals.js';
import { href } from '../lib/router.js';
import { ConfirmButton, ErrorBox } from './ui.js';

/**
 * The failed attempts at a local proposal (or a step of an iteration), folded: each one's Run,
 * which attempt it was (of which round, once it was started over), the stage it failed in and why.
 * Nothing without failures.
 */
export function FailedAttempts({ failures }: { failures: readonly FailedAttempt[] }) {
  if (failures.length === 0) return null;
  const labels = failureLabels(failures);
  return (
    <details className="proposal-failures">
      <summary>{failuresHeading(failures.length)}</summary>
      <ul>
        {failures.map((f, i) => (
          <li key={f.runId}>
            <a href={href.run(f.runId)}>Run {f.runId}</a> <span className="muted">{labels[i]}</span>
            <pre className="pre">{messageExcerpt(f.error)}</pre>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Starting a failed proposal (or step) over, confirmed first: what it does (`hint`), and why it
 * cannot be done now (`blocker`, which disables the button) if the page knows.
 */
export function RestartAction(props: {
  proposalId: string;
  hint: string | null;
  blocker?: string | null;
  onRestarted: () => void;
}) {
  const action = useAction();
  const labels = restartLabels();
  const blocker = props.blocker ?? null;
  const restart = async () => {
    if ((await action.run(() => api.restartProposal(props.proposalId))) !== undefined) {
      props.onRestarted();
    }
  };
  return (
    <>
      {props.hint && <div className="hint">{props.hint}</div>}
      <div className="proposal-actions">
        <ConfirmButton
          label={labels.label}
          confirmLabel={labels.confirm}
          disabled={action.busy || blocker !== null}
          onConfirm={() => void restart()}
        />
        {blocker && <span className="muted">{blocker}</span>}
      </div>
      <ErrorBox>{action.error}</ErrorBox>
    </>
  );
}
