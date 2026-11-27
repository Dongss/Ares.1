import { afterEach, describe, expect, it } from 'vitest';
import type { RepoDetection } from '../../../src/api/types.js';
import { setLang } from '../../../src/i18n.js';
import {
  type AddRepoForm,
  detectedBox,
  detectionNote,
  detectLabel,
  lacksVerify,
  newRepoInput,
  noVerifyBadge,
  noVerifyWarning,
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

describe('repos without verify commands', () => {
  it('are told apart by their verify commands only', () => {
    expect(lacksVerify({ verifyCommands: [] })).toBe(true);
    expect(lacksVerify({ verifyCommands: [' ', ''] })).toBe(true);
    expect(lacksVerify({ verifyCommands: ['npm test'] })).toBe(false);
  });

  it('get a badge and a warning in both languages', () => {
    expect(noVerifyBadge()).toBe('没有检查命令');
    expect(noVerifyWarning()).toContain('没有检查命令：Run 的改动不经检查就会进入评审和合并');
    setLang('en');
    expect(noVerifyBadge()).toBe('No verify commands');
    expect(noVerifyWarning()).toMatch(/^No verify commands: /);
    expect(`${noVerifyBadge()}\n${noVerifyWarning()}`).not.toMatch(/[一-鿿]/);
  });
});

describe('detecting commands on the edit form', () => {
  const detection = (verify: string[], setup: string[]): RepoDetection => ({
    branch: 'main',
    commit: '0123456789abcdef',
    verify,
    setup,
    basis: ['Go：go.mod'],
  });

  it('fills a box with its suggestions and leaves one without as typed', () => {
    expect(detectedBox(['go build ./...', 'go test ./...'], 'make')).toBe(
      'go build ./...\ngo test ./...',
    );
    expect(detectedBox([], 'npm test\nnpm run lint')).toBe('npm test\nnpm run lint');
  });

  it('says what it read and what became of the boxes, in both languages', () => {
    const found = detection(['go test ./...'], ['go mod download']);
    expect(detectionNote(found)).toContain('目标分支 main（提交 01234567）');
    expect(detectionNote(found)).toContain('点「保存」才生效');
    expect(detectionNote(detection([], []))).toContain('没有可填的建议');
    expect(detectLabel(false)).toBe('按项目文件探测');
    setLang('en');
    const texts = [
      detectionNote(found),
      detectionNote(detection([], [])),
      detectLabel(false),
      detectLabel(true),
    ];
    expect(texts[0]).toContain('target branch main (commit 01234567)');
    expect(texts[1]).toContain('Nothing to suggest');
    expect(texts.join('\n')).not.toMatch(/[一-鿿]/);
  });
});
