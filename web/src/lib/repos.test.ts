import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n.js';
import {
  type AddRepoForm,
  newRepoInput,
  REPO_ORIGINS,
  registerLabel,
  repoOriginHint,
  repoOriginLabel,
  repoPathLabel,
  targetBranchPlaceholder,
} from './repos.js';

afterEach(() => setLang('zh'));

function form(extra: Partial<AddRepoForm> = {}): AddRepoForm {
  return {
    origin: 'local',
    name: ' demo ',
    path: ' /tmp/demo ',
    url: ' git@example.com:me/demo.git ',
    targetBranch: ' ',
    verify: 'npm test\n\n npm run lint \n',
    setup: '',
    ...extra,
  };
}

describe('newRepoInput', () => {
  it('registers a local repo without a source, as before', () => {
    expect(newRepoInput(form())).toEqual({
      name: 'demo',
      path: '/tmp/demo',
      targetBranch: undefined,
      verifyCommands: ['npm test', 'npm run lint'],
      setupCommands: [],
    });
  });

  it('asks the Master to clone the trimmed address', () => {
    const input = newRepoInput(form({ origin: 'clone', targetBranch: ' dev ' }));
    expect(input.source).toEqual({ kind: 'clone', url: 'git@example.com:me/demo.git' });
    expect(input.targetBranch).toBe('dev');
  });

  it('asks the Master to make a new repo, without the address', () => {
    expect(newRepoInput(form({ origin: 'init' })).source).toEqual({ kind: 'init' });
  });
});

describe('register form texts', () => {
  it('names the three ways in both languages', () => {
    expect(REPO_ORIGINS.map(repoOriginLabel)).toEqual(['已有本地仓库', '从远端克隆', '新建空项目']);
    expect(registerLabel('clone', true)).toBe('正在克隆…');
    expect(registerLabel('clone', false)).toBe('登记');
    setLang('en');
    expect(REPO_ORIGINS.map(repoOriginLabel)).toEqual([
      'Existing local repo',
      'Clone from a remote',
      'New empty project',
    ]);
    const texts = REPO_ORIGINS.flatMap((origin) => [
      repoOriginLabel(origin),
      repoOriginHint(origin),
      repoPathLabel(origin),
      targetBranchPlaceholder(origin),
      registerLabel(origin, true),
      registerLabel(origin, false),
    ]);
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });

  it('tells where the target branch comes from by default', () => {
    expect(targetBranchPlaceholder('clone')).toBe('默认：远端的默认分支');
    expect(targetBranchPlaceholder('init')).toBe('默认：main');
  });
});
