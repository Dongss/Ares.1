import type { IterationView } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import { formatTime, type Tone } from '../lib/format.js';
import {
  elapsedText,
  ITERATION_STATUS,
  iterationCostText,
  iterationNote,
  progressPercent,
  progressText,
  runCountText,
} from '../lib/iterations.js';
import { href } from '../lib/router.js';
import { Badge, ProgressBar } from './ui.js';

/**
 * One iteration in a list (the Iterations page, Home), linking to its page: its goal, status,
 * progress, cost and time, and, while it is not over, what blocks it, who accepts it or what is
 * under way.
 */
export function IterationCard({ iteration: it }: { iteration: IterationView }) {
  const status = ITERATION_STATUS[it.status];
  const note = iterationNote(it);
  const elapsed = elapsedText(it);
  return (
    <div className="run-card iteration-card">
      <a className="run-card-link" href={href.iteration(it.id)}>
        <div className="run-card-top">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="run-card-goal">{it.title}</span>
        </div>
        <div className="iteration-goal">{it.goal}</div>
        <IterationProgress iteration={it} />
        <div className="run-card-meta">
          <span>{it.repo}</span>
          {it.issue ? (
            <span>
              {t({ zh: `迭代 #${it.issue.number}`, en: `iteration #${it.issue.number}` })}
            </span>
          ) : (
            it.source === 'local' && <span>{t({ zh: '本地提案池', en: 'Local backlog' })}</span>
          )}
          <span>{runCountText(it.totals.runs)}</span>
          <span>{iterationCostText(it)}</span>
          {elapsed && <span>{elapsed}</span>}
          <span title={it.createdAt}>{formatTime(it.createdAt)}</span>
        </div>
        {note && <div className={`iteration-note iteration-note-${note.tone}`}>{note.text}</div>}
      </a>
    </div>
  );
}

/** The tone of an iteration's progress bar, by where it stands. */
function progressTone(status: IterationView['status']): Tone {
  switch (status) {
    case 'blocked':
      return 'danger';
    case 'done':
      return 'success';
    case 'active':
      return 'active';
    default:
      return 'muted';
  }
}

/** The bar and 「完成 2/5」, colored by where the iteration stands. */
export function IterationProgress({ iteration: it }: { iteration: IterationView }) {
  const text = progressText(it.progress);
  return (
    <div className="iteration-progress">
      <ProgressBar percent={progressPercent(it)} tone={progressTone(it.status)} label={text} />
      <span className="iteration-progress-text">{text}</span>
    </div>
  );
}
