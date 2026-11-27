import type { RepoInput } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import { parseLines } from './format.js';

/**
 * Where the repo registered on the Repos page comes from: already on this machine, cloned by
 * the Master, or a new empty project the Master makes.
 */
export const REPO_ORIGINS = ['local', 'clone', 'init'] as const;
export type RepoOrigin = (typeof REPO_ORIGINS)[number];

export function repoOriginLabel(origin: RepoOrigin): string {
  switch (origin) {
    case 'local':
      return t({ zh: '已有本地仓库', en: 'Existing local repo' });
    case 'clone':
      return t({ zh: '从远端克隆', en: 'Clone from a remote' });
    case 'init':
      return t({ zh: '新建空项目', en: 'New empty project' });
  }
}

export function repoOriginHint(origin: RepoOrigin): string {
  switch (origin) {
    case 'local':
      return t({
        zh: '登记本机已有的 git 仓库，目标分支要已经存在。',
        en: 'Registers a git repo already on this machine; the target branch must exist.',
      });
    case 'clone':
      return t({
        zh: 'Master 用本机的 git 凭据把仓库克隆到下面的路径（不存在或为空的目录）再登记。地址可以是 https://、ssh://、user@host:path 或本机的绝对路径。',
        en: "The Master clones the repo with this machine's git credentials to the path below (missing or an empty directory), then registers it. The address may be https://, ssh://, user@host:path or an absolute path on this machine.",
      });
    case 'init':
      return t({
        zh: 'Master 在下面的路径（不存在或为空的目录）新建一个 git 仓库，在目标分支上做一次空的初始提交再登记。',
        en: 'The Master makes a new git repo at the path below (missing or an empty directory) with an empty first commit on the target branch, then registers it.',
      });
  }
}

export function repoPathLabel(origin: RepoOrigin): string {
  return origin === 'local'
    ? t({ zh: '本机路径（绝对路径）', en: 'Local path (absolute)' })
    : t({
        zh: '放到本机哪里（绝对路径，不存在或为空的目录）',
        en: 'Where on this machine (absolute path, missing or an empty directory)',
      });
}

export function targetBranchPlaceholder(origin: RepoOrigin): string {
  switch (origin) {
    case 'local':
      return t({ zh: '默认：当前检出的分支', en: 'Default: the branch checked out now' });
    case 'clone':
      return t({ zh: '默认：远端的默认分支', en: "Default: the remote's default branch" });
    case 'init':
      return t({ zh: '默认：main', en: 'Default: main' });
  }
}

/** The register button's text; `busy`: the request is under way (a clone may take a while). */
export function registerLabel(origin: RepoOrigin, busy: boolean): string {
  if (!busy) return t({ zh: '登记', en: 'Register' });
  switch (origin) {
    case 'local':
      return t({ zh: '登记中…', en: 'Registering…' });
    case 'clone':
      return t({ zh: '正在克隆…', en: 'Cloning…' });
    case 'init':
      return t({ zh: '正在新建…', en: 'Creating…' });
  }
}

/** What the human filled in on the register form, as typed. */
export interface AddRepoForm {
  origin: RepoOrigin;
  name: string;
  path: string;
  /** The address to clone; only read for `clone`. */
  url: string;
  targetBranch: string;
  /** Commands, one per line. */
  verify: string;
  setup: string;
}

/** The body of POST /api/repos for the form: trimmed, blank optional fields left out. */
export function newRepoInput(form: AddRepoForm): RepoInput {
  const input: RepoInput = {
    name: form.name.trim(),
    path: form.path.trim(),
    targetBranch: form.targetBranch.trim() || undefined,
    verifyCommands: parseLines(form.verify),
    setupCommands: parseLines(form.setup),
  };
  if (form.origin === 'clone') input.source = { kind: 'clone', url: form.url.trim() };
  if (form.origin === 'init') input.source = { kind: 'init' };
  return input;
}
