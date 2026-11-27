import type { RepoDetection, RepoInput } from '../../../src/api/types.js';
import { t } from '../../../src/i18n.js';
import type { Repo } from '../../../src/store/types.js';
import { parseLines, shortSha } from './format.js';

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

/**
 * The repo has no verify commands: a Run's changes then go to review and merge unchecked (a
 * template stage's own `verify.commands` aside, which this does not look at).
 */
export function lacksVerify(repo: Pick<Repo, 'verifyCommands'>): boolean {
  return repo.verifyCommands.every((command) => command.trim() === '');
}

/** The badge on the card of a repo without verify commands. */
export function noVerifyBadge(): string {
  return t({ zh: '没有检查命令', en: 'No verify commands' });
}

/** Why that badge matters, next to the empty verify commands. */
export function noVerifyWarning(): string {
  return t({
    zh: '没有检查命令：Run 的改动不经检查就会进入评审和合并。点「修改」可以按项目文件探测该填什么。',
    en: "No verify commands: a Run's changes go to review and merge without any check. Choose Edit to detect them from the project files.",
  });
}

/**
 * A commands box of the edit form once detected: the suggested commands, one per line; what was
 * typed when there is no suggestion for it. Nothing is saved.
 */
export function detectedBox(suggested: readonly string[], typed: string): string {
  return suggested.length > 0 ? suggested.join('\n') : typed;
}

/** What the edit form says after detecting: what was read, and what became of the boxes. */
export function detectionNote(detection: RepoDetection): string {
  const read = t({
    zh: `读自目标分支 ${detection.branch}（提交 ${shortSha(detection.commit)}）已提交的文件。`,
    en: `Read from the files committed on the target branch ${detection.branch} (commit ${shortSha(detection.commit)}).`,
  });
  if (detection.verify.length === 0 && detection.setup.length === 0) {
    return `${read}${t({
      zh: '没有可填的建议，输入框没有改动。',
      en: ' Nothing to suggest; the boxes are left as they were.',
    })}`;
  }
  return `${read}${t({
    zh: '建议已填进下面的输入框（没有建议的那一栏不动），检查无误后点「保存」才生效。',
    en: ' The suggestions are in the boxes below (a box without one is left as it was); they take effect once you check them and choose Save.',
  })}`;
}

/** The detect button's text; `busy`: the request is under way. */
export function detectLabel(busy: boolean): string {
  return busy
    ? t({ zh: '探测中…', en: 'Detecting…' })
    : t({ zh: '按项目文件探测', en: 'Detect from project files' });
}
