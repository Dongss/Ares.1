import { type ReactNode, useState } from 'react';
import { t } from '../../../src/i18n.js';
import type { TemplateProblem } from '../lib/config.js';
import type { Tone } from '../lib/format.js';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="error-box" role="alert">
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A button that asks for a second click before doing something destructive (no browser dialogs). */
export function ConfirmButton(props: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" disabled={props.disabled} onClick={() => setAsking(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <button
        type="button"
        className="btn-danger"
        onClick={() => {
          setAsking(false);
          props.onConfirm();
        }}
      >
        {props.confirmLabel}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        {t({ zh: '取消', en: 'Cancel' })}
      </button>
    </span>
  );
}

/** Expandable block; the body is only rendered (and fetched) while open. */
export function Collapsible(props: {
  title: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className={`collapsible ${open ? 'open' : ''} ${props.className ?? ''}`}>
      <button
        type="button"
        className="collapsible-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {props.title}
      </button>
      {open && <div className="collapsible-body">{props.children}</div>}
    </div>
  );
}

/** A bar filled to `percent` (0–100), colored by tone, with `label` read out for it. */
export function ProgressBar(props: { percent: number; tone: Tone; label: string }) {
  const percent = Math.max(0, Math.min(100, props.percent));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={props.label}
    >
      <div className={`progress-fill progress-${props.tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Preformatted text that can get long: scrolls instead of growing forever. */
export function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={`pre ${className ?? ''}`}>{children}</pre>;
}

/** The problems of the templates a repo keeps (`repoTemplateProblems`), each after its file. */
export function TemplateProblems({ problems }: { problems: TemplateProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="template-problems">
      {problems.map((p) => (
        <li key={`${p.file}\n${p.text}`} className={p.tone}>
          <code>{p.file}</code>
          {p.text}
        </li>
      ))}
    </ul>
  );
}
