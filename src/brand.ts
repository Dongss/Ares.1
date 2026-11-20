// The project's display name and slogan, shown to people (dashboard, prompts, notifications,
// issue comments), in the language in use. Pure logic, shared by the Master and the dashboard.
//
// Technical identifiers use `ares1` (package and command, data directory, issue labels,
// comment markers, branches): the running self-hosting setup depends on them, so they are
// not derived from here.

import { t } from './i18n.js';

/** The name people see. */
export function brandName(): string {
  return t({ zh: '战神一号', en: 'Ares.1' });
}

/** The slogan shown next to the name. */
export function brandSlogan(): string {
  return t({ zh: '自举永动机', en: 'Self-bootstrapping perpetual motion machine' });
}

/** Name and slogan together, e.g. for the browser tab title. */
export function brandTitle(): string {
  return `${brandName()} · ${brandSlogan()}`;
}
