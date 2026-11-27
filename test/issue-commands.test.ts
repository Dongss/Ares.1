// Commands a human writes on a Run's issue (`/ares1 approve [comment]`, `/ares1 reject <comment>`):
// how they are read (pure functions of src/github/issues.ts), and how the bridges of GitHub and
// GitLab carry them out on the issues of Runs waiting for approval (FakeGitHub, FakeGitLab).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthoredCommand,
  COMMENT_MARKER,
  type CommandOutcome,
  commandReply,
  commandsAfterMaster,
  isMasterComment,
  issueUpdate,
  LABELS,
  parseIssueCommand,
  repliesAfterMaster,
} from '../src/github/issues.js';
import type { HostComment } from '../src/host/code-host.js';
import { setLang } from '../src/i18n.js';
import type { EventRow, Run } from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  type FakeAuthor,
  FakeGitHub,
  FakeGitLab,
  GITLAB_DEVELOPER,
  GITLAB_GUEST,
  type Harness,
  harness,
  STRANGER,
  TEST_WORKFLOW_YAML,
  waitFor,
} from './helpers.js';

const CJK = /[　-〿一-鿿＀-￯]/;

/** A collaborator of "me/demo": trusted. */
const ALICE: FakeAuthor = { login: 'alice', association: 'COLLABORATOR' };

const CONFIG = `
github:
  repos:
    demo:
      template: dev
`;

const GITLAB_CONFIG = `
gitlab:
  repos:
    demo:
      issues_repo: grp/sub/demo
      template: dev
`;

/** The test template with its names in English. */
const ENGLISH_WORKFLOW = TEST_WORKFLOW_YAML.replace('测试流程', 'Test flow')
  .replace('编码', 'Coding')
  .replace('评审', 'Review')
  .replace('合并', 'Merge');

let h: Harness | undefined;
let gh: FakeGitHub;

afterEach(async () => {
  await h?.close();
  h = undefined;
  setLang('zh');
});

async function start(workflow?: string, config = CONFIG): Promise<Harness> {
  gh = new FakeGitHub();
  h = await harness({ agents: ASSESS_AGENTS_YAML, config, github: gh, workflow });
  return h;
}

/** A new Master on the closed one's home and repo, as after a restart. */
async function restart(closed: Harness): Promise<Harness> {
  h = await harness({
    agents: ASSESS_AGENTS_YAML,
    config: CONFIG,
    github: gh,
    home: closed.home,
    repoDir: closed.repoDir,
  });
  return h;
}

/** The Run of issue #1 waiting for the approval of its merge, once its issue says so. */
async function waitingRun(t: Harness, title = '加 feature'): Promise<Run> {
  gh.add({ title, body: 'feature.txt', labels: [LABELS.ready] });
  await t.master.issues.poll();
  const [created] = t.master.store.listRuns();
  if (!created) throw new Error('no run');
  await t.waitStatus(created.id, 'waiting_approval');
  await t.master.issues.sync();
  const run = t.master.store.getRun(created.id);
  expect(run.issueSynced).toBe('waiting_approval');
  return run;
}

const ofType =
  (...types: string[]) =>
  (t: Harness, runId: string): EventRow[] =>
    t.master.store.listEvents(runId).filter((e) => types.includes(e.type));
const decisions = ofType('approval.approved', 'approval.rejected');
const ignoredCommands = ofType('issue.commands_ignored');

const coderPrompts = (t: Harness) =>
  t.fake.calls.filter((c) => c.model === 'coder').map((c) => c.prompt);

describe('issue commands: reading them', () => {
  /** A comment by the repo's owner, or by `author`, trusted or not. */
  const by = (body: string, author = 'me', trusted = true): HostComment => ({
    body,
    author,
    trusted,
    role: trusted ? 'OWNER' : 'NONE',
  });
  const stranger = (body: string) => by(body, 'stranger', false);
  const master = (text: string) => by(`${text}\n\n${COMMENT_MARKER}`);

  it('reads the command on the first line, whatever the case, and the rest as its comment', () => {
    expect(parseIssueCommand('看起来不错')).toBeNull();
    expect(parseIssueCommand('可以 /ares1 approve')).toBeNull();
    expect(parseIssueCommand('  /ares1 approve  ')).toEqual({
      name: 'approve',
      note: '',
      line: '/ares1 approve',
    });
    expect(parseIssueCommand('/ARES1 Approve  看过了 ')).toEqual({
      name: 'approve',
      note: '看过了',
      line: '/ARES1 Approve  看过了',
    });
    // The comment may go on over the next lines.
    expect(parseIssueCommand('/ares1 reject\n\n测试不够\n再补一个')).toEqual({
      name: 'reject',
      note: '测试不够\n再补一个',
      line: '/ares1 reject',
    });
    expect(parseIssueCommand('/ares1　reject 不行')?.name).toBe('reject');
    for (const name of ['retry', 'confirm', 'resume', 'cancel']) {
      expect(parseIssueCommand(`/ares1 ${name}`)?.name).toBe(name);
    }
    // Commands still, but naming none the Master knows: answered with how to write one.
    for (const body of ['/ares1', '/ares1approve', '/ares1 approved 好', '/ares1\napprove']) {
      expect(parseIssueCommand(body)).toEqual({
        name: null,
        note: '',
        line: body.split('\n')[0],
      });
    }
  });

  it("takes the trusted commands after the Master's last comment; the others are counted", () => {
    expect(commandsAfterMaster([by('/ares1 approve')], 'me')).toEqual({
      commands: [],
      ignored: 0,
    });
    const comments = [
      by('/ares1 approve 早先的'),
      master('等你审批'),
      by('/ares1 approve 好', 'alice'),
      stranger('/ares1 approve'),
      by('顺便说一句'),
      by('/ares1 reject 不行'),
      // A stranger copying the marker does not make the Master's last comment later: it is
      // another command of theirs.
      stranger(`/ares1 approve\n\n${COMMENT_MARKER}`),
    ];
    expect(commandsAfterMaster(comments, 'me')).toEqual({
      commands: [
        { name: 'approve', note: '好', line: '/ares1 approve 好', author: 'alice' },
        { name: 'reject', note: '不行', line: '/ares1 reject 不行', author: 'me' },
      ],
      ignored: 2,
    });
    // Answered: read no more.
    expect(commandsAfterMaster([...comments, master('已批准')], 'me')).toEqual({
      commands: [],
      ignored: 0,
    });
  });

  it("takes no command for a reply to the assessment; a stranger's is counted as before", () => {
    const comments = [
      master('疑问'),
      by('/ares1 approve'),
      stranger('/ares1 approve'),
      by('写 ok'),
      by(' /ares1 reject 不对 '),
    ];
    expect(repliesAfterMaster(comments, 'me')).toEqual({ replies: ['写 ok'], ignored: 1 });
  });

  it('answers each outcome on the issue', () => {
    const command = (body: string, author: string | null = 'alice'): AuthoredCommand => {
      const parsed = parseIssueCommand(body);
      if (!parsed) throw new Error('no command');
      return { ...parsed, author };
    };
    const ctx = {
      stageName: '合并',
      skipped: 0,
      dashboardUrl: 'http://127.0.0.1:4870',
      runId: 'r1',
    };
    const link = '看板：http://127.0.0.1:4870/#/runs/r1';
    expect(
      commandReply({ kind: 'approved' }, { ...ctx, command: command('/ares1 approve 好') }),
    ).toBe(
      `@alice 用 \`/ares1 approve\` 批准了「合并」阶段，Run 继续往下走。\n\n意见：\n\n> 好\n\n${link}`,
    );
    expect(
      commandReply(
        { kind: 'rejected', target: '编码' },
        { ...ctx, command: command('/ares1 reject 改名', null), skipped: 2 },
      ),
    ).toBe(
      '已删除的账号 用 `/ares1 reject` 驳回了「合并」阶段，Run 带着下面的意见回到「编码」阶段返工：\n\n> 改名' +
        '\n\n之后的 2 条命令已忽略：一次只执行最早的一条，还需要的话请在这条评论之后重新发。' +
        `\n\n${link}`,
    );
    expect(
      commandReply(
        { kind: 'refused', reason: 'Run 当前状态是 running，没有待审批的事项' },
        { ...ctx, command: command('/ares1 approve') },
      ),
    ).toBe(
      `没有执行 @alice 的 \`/ares1 approve\`：\n\n> Run 当前状态是 running，没有待审批的事项\n\n${link}`,
    );
  });

  it('says on the waiting issue how to approve or reject there', () => {
    const run = { id: 'r1', status: 'waiting_approval' } as Run;
    const base = { dashboardUrl: 'http://127.0.0.1:4870', targetBranch: 'main' };
    const github = issueUpdate(run, { ...base, stageName: '合并', pollMinutes: 5 }).comment;
    expect(github).toBe(
      '等你审批：「合并」阶段。\n\n可以在看板上审批，也可以直接在这个 issue 下回复：评论第一行写 `/ares1 approve [意见]` 批准，写 `/ares1 reject <意见>` 驳回（意见必填，会交给返工的 Agent）。只认仓库成员的命令；Master 下次检查 GitHub 时（每 5 分钟）执行，并在这里回复结果。' +
        '\n\n看板：http://127.0.0.1:4870/#/runs/r1',
    );
    const gitlab = issueUpdate(run, { ...base, platform: 'gitlab' }).comment;
    expect(gitlab).toContain('Master 下次检查 GitLab 时执行');
  });

  describe('in English', () => {
    it('answers every outcome and words the waiting comment with no Chinese left', () => {
      setLang('en');
      const ctx = { stageName: 'Merge', skipped: 1, dashboardUrl: 'http://x', runId: 'r1' };
      const parsed = (body: string) =>
        parseIssueCommand(body) as NonNullable<ReturnType<typeof parseIssueCommand>>;
      const cases: [CommandOutcome, string][] = [
        [{ kind: 'approved' }, '/ares1 approve looks good'],
        [{ kind: 'rejected', target: 'Coding' }, '/ares1 reject rename it'],
        [{ kind: 'rejected', target: null }, '/ares1 reject rename it'],
        [
          { kind: 'refused', reason: 'The Run is running and has nothing awaiting approval' },
          '/ares1 approve',
        ],
        [{ kind: 'malformed' }, '/ares1 approved'],
        [{ kind: 'note_missing' }, '/ares1 reject'],
        [{ kind: 'unsupported' }, '/ares1 retry'],
      ];
      for (const [outcome, body] of cases) {
        for (const author of ['alice', null]) {
          const text = commandReply(outcome, { ...ctx, command: { ...parsed(body), author } });
          expect(text).not.toMatch(CJK);
          expect(text).toContain('Dashboard: http://x/#/runs/r1');
        }
      }
      expect(
        commandReply(
          { kind: 'approved' },
          { ...ctx, skipped: 0, command: { ...parsed('/ares1 approve'), author: 'alice' } },
        ),
      ).toBe(
        '@alice approved the "Merge" stage with `/ares1 approve`, and the Run goes on.\n\nDashboard: http://x/#/runs/r1',
      );
      const waiting = issueUpdate({ id: 'r1', status: 'waiting_approval' } as Run, {
        dashboardUrl: 'http://x',
        targetBranch: 'main',
        stageName: 'Merge',
        pollMinutes: 5,
      }).comment;
      expect(waiting).toContain(
        'Approve on the dashboard, or reply on this issue: start a comment with `/ares1 approve [comment]` to approve, or `/ares1 reject <comment>` to reject',
      );
      expect(waiting).toContain('the next time the Master checks GitHub (every 5 min)');
      expect(waiting).not.toMatch(CJK);
    });
  });
});

describe('issue commands: carried out on GitHub', () => {
  it('merges the Run on a trusted /ares1 approve, answers on the issue and reads it once', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    expect(issue.comments.at(-1)).toContain('`/ares1 approve [意见]` 批准');

    gh.commentAs(1, ALICE, '/ares1 approve 看过了，可以合并');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'completed');
    const reply = issue.comments.find((c) => c.includes('批准了')) ?? '';
    expect(reply).toContain('@alice 用 `/ares1 approve` 批准了「合并」阶段，Run 继续往下走。');
    expect(reply).toContain('> 看过了，可以合并');
    expect(isMasterComment(reply)).toBe(true);
    const [approval] = t.master.store.listApprovals(run.id);
    expect(approval).toMatchObject({ status: 'approved', comment: '看过了，可以合并' });
    expect(decisions(t, run.id).map((e) => [e.type, e.data])).toEqual([
      [
        'approval.approved',
        { approvalId: approval?.id, comment: '看过了，可以合并', source: 'issue', author: 'alice' },
      ],
    ]);

    // Polled again: carried out and answered once only.
    await t.master.issues.poll();
    await t.master.issues.sync();
    expect(decisions(t, run.id)).toHaveLength(1);
    expect(issue.comments.filter((c) => c.includes('批准了'))).toHaveLength(1);
    expect(issue.state).toBe('closed');
    expect(issue.comments.at(-1)).toContain('已合并到本地 `main`');
  });

  it('sends the Run back to its on_reject stage with the reason of /ares1 reject', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    issue.comments.push('/ares1 reject 请把文件名改成 feature.md');
    await t.master.issues.poll();
    await waitFor(
      () => t.master.store.countStageRounds(run.id, 'merge') === 2,
      'second merge round',
    );
    await t.waitStatus(run.id, 'waiting_approval');
    expect(coderPrompts(t)[1]).toContain('请把文件名改成 feature.md');
    const reply = issue.comments.find((c) => c.includes('驳回了')) ?? '';
    expect(reply).toContain(
      '@me 用 `/ares1 reject` 驳回了「合并」阶段，Run 带着下面的意见回到「编码」阶段返工：\n\n> 请把文件名改成 feature.md',
    );
    expect(decisions(t, run.id).map((e) => e.data)).toEqual([
      expect.objectContaining({
        comment: '请把文件名改成 feature.md',
        source: 'issue',
        author: 'me',
      }),
    ]);

    // Waiting again: the issue says so in a new comment, and the command before it is not read.
    await t.master.issues.sync();
    expect(issue.comments.at(-1)).toContain('等你审批：「合并」阶段');
    await t.master.issues.poll();
    expect(decisions(t, run.id)).toHaveLength(1);
    expect(t.master.store.getRun(run.id).status).toBe('waiting_approval');
  });

  it('carries out no command of somebody it does not trust, and counts them once', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    const comments = issue.comments.length;
    gh.commentAs(1, STRANGER, '/ares1 approve');
    await t.master.issues.poll();
    await t.master.issues.poll();
    expect(t.master.store.getRun(run.id).status).toBe('waiting_approval');
    expect(decisions(t, run.id)).toEqual([]);
    // Not answered either.
    expect(issue.comments).toHaveLength(comments + 1);
    const approvalId = t.master.store.pendingApproval(run.id)?.id;
    expect(ignoredCommands(t, run.id).map((e) => e.data)).toEqual([
      { repo: 'me/demo', issue: 1, approvalId, count: 1 },
    ]);

    gh.commentAs(1, ALICE, '/ares1 approve');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'completed');
    expect(decisions(t, run.id).map((e) => e.data.author)).toEqual(['alice']);
  });

  it('only answers a command when the Run no longer waits for that approval', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    issue.comments.push('/ares1 approve');
    // Approved on the dashboard while the issue's comments are read.
    const list = gh.listComments.bind(gh);
    vi.spyOn(gh, 'listComments').mockImplementation(async (repo, number) => {
      t.master.engine.approve(run.id, undefined, { source: 'dashboard' });
      return list(repo, number);
    });
    await t.master.issues.poll();
    vi.restoreAllMocks();
    const reply = issue.comments.find((c) => c.includes('没有执行')) ?? '';
    expect(reply).toMatch(
      /^没有执行 @me 的 `\/ares1 approve`：\n\n> Run 当前状态是 \w+，没有待审批的事项\n\n看板：/,
    );
    await t.waitStatus(run.id, 'completed');
    expect(decisions(t, run.id).map((e) => e.data.source)).toEqual(['dashboard']);
  });

  it('takes no command written for an approval decided on the dashboard for the next one', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    issue.comments.push('/ares1 approve');
    // Decided on the dashboard, and waiting for the next approval before the next poll.
    t.master.engine.reject(run.id, '请把文件名改成 feature.md', { source: 'dashboard' });
    await waitFor(
      () => t.master.store.countStageRounds(run.id, 'merge') === 2,
      'second merge round',
    );
    await t.waitStatus(run.id, 'waiting_approval');
    expect(t.master.store.getRun(run.id).issueSynced).toBeNull();

    await t.master.issues.poll();
    // The issue says the Run waits for the new approval; the command before it is not read.
    expect(issue.comments.at(-1)).toContain('等你审批：「合并」阶段');
    expect(issue.comments.filter((c) => c.includes('等你审批'))).toHaveLength(2);
    expect(t.master.store.getRun(run.id).status).toBe('waiting_approval');
    await t.master.issues.poll();
    expect(decisions(t, run.id).map((e) => e.data.source)).toEqual(['dashboard']);

    // A command written after it decides the new one.
    issue.comments.push('/ares1 approve');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'completed');
    expect(decisions(t, run.id).map((e) => e.data.source)).toEqual(['dashboard', 'issue']);
  });

  it('takes no command for the next approval when the one announced was decided during the update', async () => {
    const t = await start();
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    await t.waitStatus(run.id, 'waiting_approval');
    const issue = gh.get(1);
    // Rejected on the dashboard right after the issue is told the Run waits, and waiting for the
    // next approval before the issue's update is done.
    const comment = gh.comment.bind(gh);
    vi.spyOn(gh, 'comment').mockImplementation(async (repo, number, body) => {
      await comment(repo, number, body);
      if (!body.includes('等你审批')) return;
      vi.restoreAllMocks();
      t.master.engine.reject(run.id, '请把文件名改成 feature.md', { source: 'dashboard' });
      await waitFor(
        () => t.master.store.countStageRounds(run.id, 'merge') === 2,
        'second merge round',
      );
      await t.waitStatus(run.id, 'waiting_approval');
    });
    await t.master.issues.sync();
    vi.restoreAllMocks();
    expect(t.master.store.getRun(run.id).issueSynced).toBeNull();

    // Written for the approval the issue was told of.
    issue.comments.push('/ares1 approve');
    await t.master.issues.poll();
    expect(issue.comments.at(-1)).toContain('等你审批：「合并」阶段');
    expect(t.master.store.getRun(run.id)).toMatchObject({
      status: 'waiting_approval',
      issueSynced: 'waiting_approval',
    });
    expect(decisions(t, run.id).map((e) => e.data.source)).toEqual(['dashboard']);
  });

  it('answers a malformed command, a rejection without its reason and an unsupported one without acting', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    const answer = async (body: string) => {
      issue.comments.push(body);
      await t.master.issues.poll();
      return issue.comments.at(-1) ?? '';
    };

    const malformed = await answer('/ares1 approved');
    expect(malformed).toContain('没看懂 @me 的命令，没有执行：\n\n> /ares1 approved');
    expect(malformed).toContain('`/ares1 approve [意见]` 批准');
    expect(await answer('/ares1 reject')).toContain(
      '@me 的 `/ares1 reject` 没有写意见，没有执行。',
    );
    expect(await answer('/ares1 RETRY')).toContain(
      '@me 的 `/ares1 retry` 在 issue 上暂不支持，没有执行。',
    );
    expect(t.master.store.getRun(run.id).status).toBe('waiting_approval');
    expect(decisions(t, run.id)).toEqual([]);

    // Several at once: the earliest is carried out, the later ones named as ignored.
    issue.comments.push('/ares1 reject\n\n测试不够', '/ares1 approve');
    await t.master.issues.poll();
    const reply = issue.comments.find((c) => c.includes('驳回了')) ?? '';
    expect(reply).toContain('> 测试不够');
    expect(reply).toContain('之后的 1 条命令已忽略');
    expect(decisions(t, run.id).map((e) => [e.type, e.data.comment])).toEqual([
      ['approval.rejected', '测试不够'],
    ]);
  });

  it('carries out a command once, even when the Master stopped before answering it', async () => {
    const t = await start();
    const run = await waitingRun(t);
    const issue = gh.get(1);
    issue.comments.push('/ares1 reject 请把文件名改成 feature.md');
    // The answer never reaches the issue, as if the Master had stopped right after deciding.
    gh.failing.set('comment #1', 'connection reset');
    await t.master.issues.poll();
    expect(decisions(t, run.id)).toHaveLength(1);
    await waitFor(
      () => t.master.store.countStageRounds(run.id, 'merge') === 2,
      'second merge round',
    );
    await t.waitStatus(run.id, 'waiting_approval');
    expect(issue.comments.at(-1)).toBe('/ares1 reject 请把文件名改成 feature.md');
    await t.close();
    h = undefined;
    gh.failing.clear();

    const again = await restart(t);
    await again.master.issues.poll();
    // The issue says the Run waits again before a command is read for it: the earlier one is not.
    expect(issue.comments.at(-1)).toContain('等你审批：「合并」阶段');
    await again.master.issues.poll();
    expect(decisions(again, run.id)).toHaveLength(1);
    expect(again.master.store.getRun(run.id).status).toBe('waiting_approval');
    expect(again.fake.calls).toEqual([]);
  });

  it('takes no command on a Run under discussion for a reply', async () => {
    const t = await start(ASSESS_WORKFLOW_YAML);
    const assessorCalls = () => t.fake.calls.filter((c) => c.model === 'assessor');
    t.scripts.assessor = (ctx) => {
      if (assessorCalls().length === 1) return assessment('ask', { questions: ['写什么？'] });
      expect(ctx.input.prompt).toContain('写 ok');
      expect(ctx.input.prompt).not.toContain('/ares1');
      return assessment('go');
    };
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    await t.waitStatus(run.id, 'blocked');
    await t.master.issues.sync();
    const issue = gh.get(1);

    issue.comments.push('/ares1 approve');
    gh.commentAs(1, STRANGER, '/ares1 approve');
    await t.master.issues.poll();
    await t.master.issues.poll();
    expect(assessorCalls()).toHaveLength(1);
    const waiting = t.master.store.getRun(run.id);
    expect(waiting.status).toBe('blocked');
    // The stranger's command counts among the comments not taken, as any of theirs.
    expect(waiting.discussion.at(-1)).toMatchObject({ role: 'assessor', ignoredComments: 1 });
    expect(issue.comments.some((c) => c.includes('没有执行'))).toBe(false);

    issue.comments.push('写 ok');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'completed');
    expect(assessorCalls()).toHaveLength(2);
  });

  it('answers in English, with no Chinese left', async () => {
    const t = await start(ENGLISH_WORKFLOW, `language: en\n${CONFIG}`);
    const run = await waitingRun(t, 'Add a feature');
    const issue = gh.get(1);
    const waiting = issue.comments.at(-1) ?? '';
    expect(waiting).toContain('Waiting for your approval of the "Merge" stage.');
    expect(waiting).not.toMatch(CJK);
    const from = issue.comments.length;

    for (const body of ['/ares1 approved', '/ares1 reject', '/ares1 cancel']) {
      issue.comments.push(body);
      await t.master.issues.poll();
    }
    issue.comments.push('/ares1 reject Rename the file', '/ares1 approve');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'waiting_approval');
    await t.master.issues.sync();
    issue.comments.push('/ares1 approve');
    const list = gh.listComments.bind(gh);
    vi.spyOn(gh, 'listComments').mockImplementation(async (repo, number) => {
      t.master.engine.approve(run.id, undefined, { source: 'dashboard' });
      return list(repo, number);
    });
    await t.master.issues.poll();
    vi.restoreAllMocks();

    const replies = issue.comments.slice(from).filter(isMasterComment);
    expect(replies.length).toBeGreaterThanOrEqual(6);
    for (const reply of replies) expect(reply).not.toMatch(CJK);
    const text = replies.join('\n');
    expect(text).toContain("@me's command was not understood");
    expect(text).toContain("@me's `/ares1 reject` has no comment");
    expect(text).toContain("@me's `/ares1 cancel` is not supported on issues yet");
    expect(text).toContain(
      '@me rejected the "Merge" stage with `/ares1 reject`: the Run goes back to the "Coding" stage',
    );
    expect(text).toContain('The later command was ignored');
    expect(text).toMatch(
      /@me's `\/ares1 approve` was not carried out:\n\n> The Run is \w+ and has nothing awaiting approval/,
    );
  });
});

describe('issue commands: carried out on GitLab', () => {
  it("approves on a Developer's /ares1 approve; a Guest's is only counted", async () => {
    const gl = new FakeGitLab();
    h = await harness({ agents: ASSESS_AGENTS_YAML, config: GITLAB_CONFIG, gitlab: gl });
    const t = h;
    gl.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.gitlabIssues.poll();
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    await t.waitStatus(run.id, 'waiting_approval');
    await t.master.gitlabIssues.sync();
    const issue = gl.get(1);
    expect(issue.comments.at(-1)).toContain('Master 下次检查 GitLab 时（每 5 分钟）执行');

    gl.commentAs(1, GITLAB_GUEST, '/ares1 approve');
    await t.master.gitlabIssues.poll();
    expect(t.master.store.getRun(run.id).status).toBe('waiting_approval');
    expect(ignoredCommands(t, run.id).map((e) => e.data)).toEqual([
      expect.objectContaining({ repo: 'grp/sub/demo', issue: 1, count: 1, platform: 'gitlab' }),
    ]);

    gl.commentAs(1, GITLAB_DEVELOPER, '/ares1 approve');
    await t.master.gitlabIssues.poll();
    await t.waitStatus(run.id, 'completed');
    const reply = issue.comments.find((c) => c.includes('批准了')) ?? '';
    expect(reply).toContain('@dev 用 `/ares1 approve` 批准了「合并」阶段');
    expect(isMasterComment(reply)).toBe(true);
    expect(decisions(t, run.id).map((e) => e.data)).toEqual([
      expect.objectContaining({ source: 'issue', author: 'dev' }),
    ]);
  });
});
