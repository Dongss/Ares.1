import type { ConfigView } from '../../../src/api/types.js';
import { agentEffort } from '../../../src/config/effort.js';
import type { AgentEntry, WorkflowTemplate } from '../../../src/config/schema.js';
import { t } from '../../../src/i18n.js';
import type { Tone } from './format.js';

// The read-only config page: templates with their source files, and every agent entry.

export interface TemplateCard {
  /** "workflows/<file>". */
  key: string;
  file: string;
  path: string;
  /** The YAML as written. */
  source: string;
  /** The loaded template; null when the file is invalid. */
  template: WorkflowTemplate | null;
  errors: string[];
  warnings: string[];
}

/** Template files split into loaded templates and invalid files, both in file order. */
export function templateCards(view: ConfigView): {
  valid: TemplateCard[];
  invalid: TemplateCard[];
} {
  const valid: TemplateCard[] = [];
  const invalid: TemplateCard[] = [];
  for (const f of view.templateFiles) {
    const template = view.templates.find((t) => t.id === f.templateId) ?? null;
    const card: TemplateCard = {
      key: f.key,
      file: f.file,
      path: f.path,
      source: f.source,
      template,
      errors: f.errors,
      warnings: f.warnings,
    };
    (template ? valid : invalid).push(card);
  }
  return { valid, invalid };
}

/** Warnings about config.yaml itself, e.g. unknown keys that were ignored. */
export function configFileWarnings(view: ConfigView): string[] {
  return view.warnings['config.yaml'] ?? [];
}

/** DOM id of a template's card, the target of 「查看全部模板」. */
export const templateAnchor = (id: string): string => `template-${id}`;

export interface AgentRow {
  id: string;
  state: AgentEntry['state'];
  /** null when the entry is invalid and does not say. */
  cli: string | null;
  model: string | null;
  /** null: the CLI default for a valid entry, unknown for an invalid one. */
  effort: string | null;
  tier: string | null;
  cost: string | null;
  tags: string[];
  /** Why the agent is not in use; null when it is. */
  reason: string | null;
}

/** A badge whose label is picked in the language in use when read, not at import. */
function badge(zh: string, en: string, tone: Tone): { readonly label: string; tone: Tone } {
  return {
    get label() {
      return t({ zh, en });
    },
    tone,
  };
}

export const AGENT_STATE: Record<AgentEntry['state'], { readonly label: string; tone: Tone }> = {
  enabled: badge('启用', 'Enabled', 'success'),
  disabled: badge('停用', 'Disabled', 'muted'),
  invalid: badge('无效', 'Invalid', 'danger'),
};

/** One table row per agents.yaml entry, in file order. */
export function agentRows(view: ConfigView): AgentRow[] {
  return view.agentEntries.map(agentRow);
}

/** The table row of one agents.yaml entry (also used by the 「Agent」 page). */
export function agentRow(entry: AgentEntry): AgentRow {
  const c = entry.config;
  return {
    id: entry.id,
    state: entry.state,
    cli: c?.cli ?? entry.rawCli,
    model: c?.model ?? entry.rawModel,
    effort: c ? (agentEffort(c) ?? null) : null,
    tier: c?.tier ?? null,
    cost: c?.cost ?? null,
    tags: c?.tags ?? [],
    reason:
      entry.state === 'invalid'
        ? entry.errors.join(t({ zh: '；', en: '; ' })) ||
          t({ zh: '配置无效', en: 'Invalid configuration' })
        : entry.state === 'disabled'
          ? t({ zh: '配置了 enabled: false', en: 'Set to enabled: false' })
          : null,
  };
}
