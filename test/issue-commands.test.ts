// Commands a human writes on a Run's issue (`/ares1 approve [comment]`, `/ares1 reject <comment>`):
// how they are read (pure functions of src/github/issues.ts), and how the bridges of GitHub and
// GitLab carry them out on the issues of Runs waiting for approval (FakeGitHub, FakeGitLab).

import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthoredCommand,
  COMMENT_MARKER,
  type CommandOutcome,
  type CommandState,
  commandReply,
  commandState,
  commandsAfterMaster,
  commandsFor,
  isMasterComment,
  issueUpdate,
  LABELS,
  parseIssueCommand,
  repliesAfterMaster,
} from '../src/github/issues.js';
import type { HostComment } from '../src/host/code-host.js';
import { setLang } from '../src/i18n.js';
import type { BlockKind, EventRow, Run } from '../src/store/types.js';
import {
  ASSESS_AGENTS_YAML,
  ASSESS_WORKFLOW_YAML,
  assessment,
  done,
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
  writeFile,
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
      state: 'approval' as const,
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

    const stuck = { ...ctx, state: 'blocked' as const, stageName: undefined };
    expect(
      commandReply({ kind: 'retried' }, { ...stuck, command: command('/ares1 retry 换个思路') }),
    ).toBe(
      `@alice 用 \`/ares1 retry\` 重试了，Run 重新排队。\n\n补充说明：\n\n> 换个思路\n\n${link}`,
    );
    expect(commandReply({ kind: 'retried' }, { ...stuck, command: command('/ares1 retry') })).toBe(
      `@alice 用 \`/ares1 retry\` 重试了，Run 重新排队。\n\n${link}`,
    );
    expect(
      commandReply(
        { kind: 'confirmed' },
        { ...stuck, state: 'untrusted_issue', command: command('/ares1 confirm') },
      ),
    ).toBe(`@alice 用 \`/ares1 confirm\` 确认了需求，Run 开始做，之后照常按流程走。\n\n${link}`);
    expect(
      commandReply(
        { kind: 'resumed' },
        { ...stuck, state: 'paused', command: command('/ares1 resume') },
      ),
    ).toBe(`@alice 用 \`/ares1 resume\` 让暂停的 Run 继续，Run 重新排队。\n\n${link}`);
    expect(
      commandReply({ kind: 'cancelled' }, { ...stuck, command: command('/ares1 cancel') }),
    ).toBe(`@alice 用 \`/ares1 cancel\` 终止了 Run。\n\n${link}`);

    // Not for what the Run is at: why, and the commands it takes now.
    const notNow = (state: CommandState, body: string) =>
      commandReply({ kind: 'not_applicable' }, { ...stuck, state, command: command(body) });
    expect(notNow('approval', '/ares1 retry')).toBe(
      '@alice 的 `/ares1 retry` 现在不适用，没有执行。\n\n' +
        'Run 在等审批。在这个 issue 上现在可以：评论第一行写 `/ares1 approve [意见]` 批准，写 `/ares1 reject <意见>` 驳回（意见必填，会交给返工的 Agent），写 `/ares1 cancel` 终止 Run。' +
        `\n\n${link}`,
    );
    expect(notNow('paused', '/ares1 approve')).toContain(
      'Run 暂停了。在这个 issue 上现在可以：评论第一行写 `/ares1 resume` 继续，写 `/ares1 cancel` 终止 Run。',
    );
    expect(notNow('untrusted_issue', '/ares1 retry')).toContain(
      'Run 在等仓库成员确认 issue 作者写的需求。在这个 issue 上现在可以：评论第一行写 `/ares1 confirm` 确认需求，Run 开始做，写 `/ares1 cancel` 终止 Run。',
    );
    expect(notNow('discussion', '/ares1 retry')).toContain(
      'Run 在等需求评估疑问的回复：直接在这个 issue 下回复就行，不用写命令，评估会带着回复重新做。在这个 issue 上现在可以：评论第一行写 `/ares1 cancel` 终止 Run。',
    );
    expect(notNow('budget', '/ares1 retry')).toContain('请在看板上重试并给出新的预算');
    expect(notNow('pr_open', '/ares1 retry')).toContain('Run 在等 GitHub 上的 PR 合并');
    expect(
      commandReply(
        { kind: 'not_applicable' },
        { ...stuck, state: 'pr_open', platform: 'gitlab', command: command('/ares1 retry') },
      ),
    ).toContain('Run 在等 GitLab 上的 MR 合并');
    expect(notNow('active', '/ares1 resume')).toContain(
      'Run 在排队或执行中。在这个 issue 上现在可以：评论第一行写 `/ares1 cancel` 终止 Run。',
    );
  });

  it('takes each command only in the states it is for', () => {
    expect(commandState({ status: 'waiting_approval', blocked: null })).toBe('approval');
    expect(commandState({ status: 'paused', blocked: null })).toBe('paused');
    expect(commandState({ status: 'queued', blocked: null })).toBe('active');
    expect(commandState({ status: 'running', blocked: null })).toBe('active');
    for (const kind of ['untrusted_issue', 'discussion', 'pr_open', 'budget'] as const) {
      expect(commandState({ status: 'blocked', blocked: { kind, message: '' } })).toBe(kind);
    }
    for (const kind of ['task_failed', 'error', 'max_loops', 'setup_failed'] as const) {
      expect(commandState({ status: 'blocked', blocked: { kind, message: '' } })).toBe('blocked');
    }
    for (const status of ['completed', 'failed', 'cancelled', 'dropped'] as const) {
      expect(commandState({ status, blocked: null })).toBeNull();
    }
    expect(commandsFor('approval')).toEqual(['approve', 'reject', 'cancel']);
    expect(commandsFor('blocked')).toEqual(['retry', 'cancel']);
    expect(commandsFor('untrusted_issue')).toEqual(['confirm', 'cancel']);
    expect(commandsFor('paused')).toEqual(['resume', 'cancel']);
    // Not retried on the issue: replied to, merged or closed on the code host, or given a new
    // budget on the dashboard.
    for (const state of ['discussion', 'pr_open', 'budget', 'active'] as const) {
      expect(commandsFor(state)).toEqual(['cancel']);
    }
  });

  it('says on the issue of a stuck Run, and of one by a stranger, which commands it takes', () => {
    const base = { dashboardUrl: 'http://127.0.0.1:4870', targetBranch: 'main', pollMinutes: 5 };
    const blocked = (kind: BlockKind, extra: Partial<Run> = {}) =>
      issueUpdate(
        { id: 'r1', status: 'blocked', blocked: { kind, message: '测试没过' }, ...extra } as Run,
        base,
      ).comment ?? '';
    expect(blocked('task_failed')).toBe(
      'Run 卡住了，需要你处理：\n\n> 测试没过\n\n' +
        '可以在看板上处理，也可以直接在这个 issue 下回复：评论第一行写 `/ares1 retry [说明]` 重试（说明会交给 Agent），写 `/ares1 cancel` 终止 Run。只认仓库成员的命令；Master 下次检查 GitHub 时（每 5 分钟）执行，并在这里回复结果。' +
        '\n\n看板：http://127.0.0.1:4870/#/runs/r1',
    );
    const budget = blocked('budget');
    expect(budget).toContain(
      '要接着做，请在看板上重试并给出新的预算；要终止，也可以直接在这个 issue 下回复：评论第一行写 `/ares1 cancel` 终止 Run。',
    );
    expect(budget).not.toContain('/ares1 retry');
    const untrusted = blocked('untrusted_issue', {
      issue: {
        untrusted: { author: 'stranger', association: 'NONE', confirmedAt: null },
      } as Run['issue'],
    });
    expect(untrusted).toContain(
      '仓库成员读过需求后，也可以直接在这个 issue 下回复：评论第一行写 `/ares1 confirm` 确认需求，Run 开始做，写 `/ares1 cancel` 终止 Run。只认仓库成员的命令；Master 下次检查 GitHub 时（每 5 分钟）执行，并在这里回复结果。issue 作者自己回复不算。',
    );
    // No comment while paused: a member replies `/ares1 resume` to the Run's last comment.
    expect(issueUpdate({ id: 'r1', status: 'paused' } as Run, base).comment).toBeNull();
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
      const ctx = {
        state: 'approval' as CommandState,
        stageName: 'Merge',
        skipped: 1,
        dashboardUrl: 'http://x',
        runId: 'r1',
      };
      const parsed = (body: string) =>
        parseIssueCommand(body) as NonNullable<ReturnType<typeof parseIssueCommand>>;
      const cases: [CommandOutcome, string][] = [
        [{ kind: 'approved' }, '/ares1 approve looks good'],
        [{ kind: 'rejected', target: 'Coding' }, '/ares1 reject rename it'],
        [{ kind: 'rejected', target: null }, '/ares1 reject rename it'],
        [{ kind: 'retried' }, '/ares1 retry try another way'],
        [{ kind: 'retried' }, '/ares1 retry'],
        [{ kind: 'confirmed' }, '/ares1 confirm'],
        [{ kind: 'resumed' }, '/ares1 resume'],
        [{ kind: 'cancelled' }, '/ares1 cancel'],
        [
          { kind: 'refused', reason: 'The Run is running and has nothing awaiting approval' },
          '/ares1 approve',
        ],
        [{ kind: 'malformed' }, '/ares1 approved'],
        [{ kind: 'note_missing' }, '/ares1 reject'],
        [{ kind: 'not_applicable' }, '/ares1 retry'],
      ];
      const states: CommandState[] = [
        'approval',
        'untrusted_issue',
        'discussion',
        'pr_open',
        'budget',
        'blocked',
        'paused',
        'active',
      ];
      for (const [outcome, body] of cases) {
        for (const author of ['alice', null]) {
          for (const state of states) {
            for (const platform of ['github', 'gitlab'] as const) {
              const command = { ...parsed(body), author };
              const text = commandReply(outcome, { ...ctx, state, platform, command });
              expect(text).not.toMatch(CJK);
              expect(text).toContain('Dashboard: http://x/#/runs/r1');
            }
          }
        }
      }
      const answer = (outcome: CommandOutcome, state: CommandState, body: string) =>
        commandReply(outcome, {
          ...ctx,
          state,
          stageName: undefined,
          skipped: 0,
          command: { ...parsed(body), author: 'alice' },
        });
      expect(answer({ kind: 'retried' }, 'blocked', '/ares1 retry try X')).toBe(
        '@alice retried the Run with `/ares1 retry`, and it is queued again.\n\nNote:\n\n> try X\n\nDashboard: http://x/#/runs/r1',
      );
      expect(answer({ kind: 'not_applicable' }, 'paused', '/ares1 retry')).toBe(
        "@alice's `/ares1 retry` does not apply now, so it was not carried out.\n\n" +
          'The Run is paused. On this issue you can now start a comment with `/ares1 resume` to resume it, or `/ares1 cancel` to cancel the Run.' +
          '\n\nDashboard: http://x/#/runs/r1',
      );
      expect(answer({ kind: 'not_applicable' }, 'approval', '/ares1 resume')).toContain(
        'start a comment with `/ares1 approve [comment]` to approve, `/ares1 reject <comment>` to reject (the comment is required and goes to the agent that reworks it), or `/ares1 cancel` to cancel the Run.',
      );
      for (const kind of ['task_failed', 'budget', 'untrusted_issue'] as const) {
        const comment = issueUpdate(
          {
            id: 'r1',
            status: 'blocked',
            blocked: { kind, message: 'Tests failed' },
            issue: { untrusted: { author: null, association: 'NONE', confirmedAt: null } },
          } as Run,
          { dashboardUrl: 'http://x', targetBranch: 'main', pollMinutes: 5, platform: 'gitlab' },
        ).comment;
        expect(comment).toContain('/ares1 cancel` to cancel the Run');
        expect(comment).toContain('the next time the Master checks GitLab (every 5 min)');
        expect(comment).not.toMatch(CJK);
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
      /^没有执行 @me 的 `\/ares1 approve`：\n\n> 读这条命令时 Run 的状态变了（现在是 \w+），命令是给之前的状态的。还需要的话，请重新回复。\n\n看板：/,
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

  it('answers a malformed command, a rejection without its reason and one not for an approval without acting', async () => {
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
    const retry = await answer('/ares1 RETRY');
    expect(retry).toContain('@me 的 `/ares1 retry` 现在不适用，没有执行。');
    expect(retry).toContain('Run 在等审批。在这个 issue 上现在可以：');
    expect(await answer('/ares1 resume')).toContain(
      '@me 的 `/ares1 resume` 现在不适用，没有执行。',
    );
    expect(await answer('/ares1 confirm')).toContain(
      '@me 的 `/ares1 confirm` 现在不适用，没有执行。',
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
    expect(assessorCalls()).toHaveLength(1);
    const waiting = t.master.store.getRun(run.id);
    expect(waiting.status).toBe('blocked');
    // The stranger's command counts among the comments not taken, as any of theirs.
    expect(waiting.discussion.at(-1)).toMatchObject({ role: 'assessor', ignoredComments: 1 });
    // The trusted one is answered: not for a discussion, which waits for a reply.
    expect(issue.comments.at(-1)).toContain('@me 的 `/ares1 approve` 现在不适用，没有执行。');
    expect(issue.comments.at(-1)).toContain('直接在这个 issue 下回复就行，不用写命令');
    await t.master.issues.poll();
    expect(assessorCalls()).toHaveLength(1);

    issue.comments.push('写 ok');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'completed');
    expect(assessorCalls()).toHaveLength(2);
  });

  it('passes on a reply written before a command to the discussion first', async () => {
    const t = await start(ASSESS_WORKFLOW_YAML);
    const assessorCalls = () => t.fake.calls.filter((c) => c.model === 'assessor');
    t.scripts.assessor = () =>
      assessorCalls().length === 1
        ? assessment('ask', { questions: ['写什么？'] })
        : assessment('go');
    gh.add({ title: '加 feature', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const [run] = t.master.store.listRuns();
    if (!run) throw new Error('no run');
    await t.waitStatus(run.id, 'blocked');
    await t.master.issues.sync();
    const issue = gh.get(1);
    // Written while the Master was between the replies and the commands.
    const list = gh.listComments.bind(gh);
    let reads = 0;
    vi.spyOn(gh, 'listComments').mockImplementation(async (repo, number) => {
      reads++;
      if (reads === 2) issue.comments.push('写 ok', '/ares1 retry');
      return list(repo, number);
    });
    await t.master.issues.poll();
    vi.restoreAllMocks();
    expect(reads).toBe(2);
    // Not answered yet: the answer would hide the reply before it.
    expect(issue.comments.at(-1)).toBe('/ares1 retry');

    await t.master.issues.poll();
    await waitFor(() => assessorCalls().length === 2, 'second assessment');
    expect(assessorCalls()[1]?.prompt).toContain('写 ok');
  });

  it('answers in English, with no Chinese left', async () => {
    const t = await start(ENGLISH_WORKFLOW, `language: en\n${CONFIG}`);
    const run = await waitingRun(t, 'Add a feature');
    const issue = gh.get(1);
    const waiting = issue.comments.at(-1) ?? '';
    expect(waiting).toContain('Waiting for your approval of the "Merge" stage.');
    expect(waiting).not.toMatch(CJK);
    const from = issue.comments.length;

    for (const body of ['/ares1 approved', '/ares1 reject', '/ares1 resume']) {
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
    expect(text).toContain(
      "@me's `/ares1 resume` does not apply now, so it was not carried out.\n\nThe Run waits for approval.",
    );
    expect(text).toContain(
      '@me rejected the "Merge" stage with `/ares1 reject`: the Run goes back to the "Coding" stage',
    );
    expect(text).toContain('The later command was ignored');
    expect(text).toMatch(
      /@me's `\/ares1 approve` was not carried out:\n\n> While the command was read, the Run's status changed \(it is now \w+\)/,
    );
  });
});

/** The test template, with a task that fails waiting for a human at once. */
const STUCK_WORKFLOW = TEST_WORKFLOW_YAML.replace(
  'max_retries: 2',
  'max_retries: 0\n    on_exhausted: human',
);

/** A coder that writes no result the first `failures` times: the Run is stuck on its task. */
function failingCoder(t: Harness, failures: number): void {
  let calls = 0;
  t.scripts.coder = (ctx) => {
    calls++;
    if (calls <= failures) return { finalMessage: '没写完' };
    writeFile(join(ctx.input.workdir, 'feature.txt'), 'ok\n');
    return done('写了 feature.txt');
  };
}

/** The Run of issue #1, once it is in `status` and the issue says so. */
async function runOfIssue(t: Harness, status: Run['status']): Promise<Run> {
  const [created] = t.master.store.listRuns();
  if (!created) throw new Error('no run');
  await t.waitStatus(created.id, status);
  await t.master.issues.sync();
  const run = t.master.store.getRun(created.id);
  expect(run.issueSynced).toBe(status);
  return run;
}

const retries = ofType('run.retry');

describe('issue commands: stuck, paused and from strangers', () => {
  it('retries a stuck Run on /ares1 retry, its note going to the next coding round', async () => {
    const t = await start(STUCK_WORKFLOW);
    failingCoder(t, 1);
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'blocked');
    expect(run.blocked?.kind).toBe('task_failed');
    const issue = gh.get(1);
    expect(issue.labels).toEqual([LABELS.needsYou]);
    const stuck = issue.comments.at(-1) ?? '';
    expect(stuck).toContain('Run 卡住了，需要你处理');
    expect(stuck).toContain(
      '也可以直接在这个 issue 下回复：评论第一行写 `/ares1 retry [说明]` 重试（说明会交给 Agent），写 `/ares1 cancel` 终止 Run。',
    );

    gh.commentAs(1, ALICE, '/ares1 retry 文件名用 feature.txt，内容写 ok');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'waiting_approval');
    expect(coderPrompts(t)).toHaveLength(2);
    expect(coderPrompts(t)[1]).toContain('人工补充说明：文件名用 feature.txt，内容写 ok');
    const reply = issue.comments.find((c) => c.includes('重试了')) ?? '';
    expect(reply).toContain('@alice 用 `/ares1 retry` 重试了，Run 重新排队。');
    expect(reply).toContain('补充说明：\n\n> 文件名用 feature.txt，内容写 ok');
    expect(isMasterComment(reply)).toBe(true);
    expect(retries(t, run.id).map((e) => e.data)).toEqual([
      {
        kind: 'task_failed',
        note: '文件名用 feature.txt，内容写 ok',
        source: 'issue',
        author: 'alice',
      },
    ]);

    // Polled again: carried out and answered once only.
    await t.master.issues.poll();
    await t.master.issues.sync();
    expect(retries(t, run.id)).toHaveLength(1);
    expect(issue.comments.filter((c) => c.includes('重试了'))).toHaveLength(1);
    expect(issue.comments.at(-1)).toContain('等你审批');
  });

  it("starts a stranger's issue on a member's /ares1 confirm, never on the author's own", async () => {
    const t = await start();
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready], author: STRANGER });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'blocked');
    expect(run.blocked?.kind).toBe('untrusted_issue');
    const issue = gh.get(1);
    expect(issue.comments.at(-1)).toContain(
      '仓库成员读过需求后，也可以直接在这个 issue 下回复：评论第一行写 `/ares1 confirm` 确认需求，Run 开始做，写 `/ares1 cancel` 终止 Run。',
    );
    const comments = issue.comments.length;

    gh.commentAs(1, STRANGER, '/ares1 confirm');
    await t.master.issues.poll();
    await t.master.issues.poll();
    expect(t.master.store.getRun(run.id)).toMatchObject({
      status: 'blocked',
      issue: expect.objectContaining({
        untrusted: expect.objectContaining({ confirmedAt: null }),
      }),
    });
    expect(t.fake.calls).toEqual([]);
    // Not answered, only counted once.
    expect(issue.comments).toHaveLength(comments + 1);
    expect(ignoredCommands(t, run.id).map((e) => e.data)).toEqual([
      { repo: 'me/demo', issue: 1, status: 'blocked', kind: 'untrusted_issue', count: 1 },
    ]);

    // Retry is not how a goal is confirmed on the issue.
    gh.commentAs(1, ALICE, '/ares1 retry');
    await t.master.issues.poll();
    expect(issue.comments.at(-1)).toContain('@alice 的 `/ares1 retry` 现在不适用，没有执行。');
    expect(issue.comments.at(-1)).toContain('Run 在等仓库成员确认 issue 作者写的需求。');
    expect(t.master.store.getRun(run.id).status).toBe('blocked');

    gh.commentAs(1, ALICE, '/ares1 confirm');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'waiting_approval');
    expect(t.master.store.getRun(run.id).issue?.untrusted?.confirmedAt).toEqual(expect.any(String));
    const reply = issue.comments.find((c) => c.includes('确认了需求')) ?? '';
    expect(reply).toContain('@alice 用 `/ares1 confirm` 确认了需求，Run 开始做');
    expect(retries(t, run.id).map((e) => e.data)).toEqual([
      { kind: 'untrusted_issue', source: 'issue', author: 'alice' },
    ]);
    expect(coderPrompts(t)[0]).toContain('feature.txt');
  });

  it('resumes a paused Run on /ares1 resume', async () => {
    const t = await start();
    const waiting = await waitingRun(t);
    await t.master.engine.pause(waiting.id);
    const run = await runOfIssue(t, 'paused');
    const issue = gh.get(1);
    // Paused, the issue gets no comment: commands go after the Master's last one.
    expect(issue.comments.at(-1)).toContain('等你审批');
    expect(issue.labels).toEqual([LABELS.needsYou]);

    issue.comments.push('/ares1 approve');
    await t.master.issues.poll();
    expect(issue.comments.at(-1)).toContain('@me 的 `/ares1 approve` 现在不适用，没有执行。');
    expect(issue.comments.at(-1)).toContain(
      'Run 暂停了。在这个 issue 上现在可以：评论第一行写 `/ares1 resume` 继续，写 `/ares1 cancel` 终止 Run。',
    );
    expect(t.master.store.getRun(run.id).status).toBe('paused');

    issue.comments.push('/ares1 resume');
    await t.master.issues.poll();
    expect(issue.comments.some((c) => c.includes('@me 用 `/ares1 resume` 让暂停的 Run 继续'))).toBe(
      true,
    );
    await t.waitStatus(run.id, 'waiting_approval');
    expect(
      ofType('run.resumed')(t, run.id)
        .filter((e) => e.data.source)
        .map((e) => e.data),
    ).toEqual([{ source: 'issue', author: 'me' }]);
  });

  it('cancels a running Run on /ares1 cancel, and the issue is updated as usual', async () => {
    const t = await start();
    t.scripts.coder = async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      return done();
    };
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'running');
    const issue = gh.get(1);

    // A stranger's is only counted.
    gh.commentAs(1, STRANGER, '/ares1 cancel');
    await t.master.issues.poll();
    expect(t.master.store.getRun(run.id).status).toBe('running');
    expect(ignoredCommands(t, run.id).map((e) => e.data)).toEqual([
      { repo: 'me/demo', issue: 1, status: 'running', count: 1 },
    ]);

    gh.commentAs(1, ALICE, '/ares1 cancel');
    await t.master.issues.poll();
    expect(t.master.store.getRun(run.id).status).toBe('cancelled');
    expect(issue.comments.at(-1)).toContain('@alice 用 `/ares1 cancel` 终止了 Run。');
    const cancelled = ofType('run.status')(t, run.id).filter((e) => e.data.status === 'cancelled');
    expect(cancelled.map((e) => e.data)).toEqual([
      { status: 'cancelled', source: 'issue', author: 'alice' },
    ]);

    await t.master.issues.poll();
    expect(issue.labels).toEqual([LABELS.failed]);
    expect(issue.comments.at(-1)).toContain('Run 已终止。要重做，重新加上 `ares1:ready` 标签。');
    expect(issue.state).toBe('open');
    // Ended: no command is read any more.
    issue.comments.push('/ares1 cancel');
    await t.master.issues.poll();
    expect(issue.comments.at(-1)).toBe('/ares1 cancel');
  });

  it('only answers a command a stuck Run does not take, changing nothing', async () => {
    const t = await start(STUCK_WORKFLOW);
    failingCoder(t, 1);
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'blocked');
    const issue = gh.get(1);
    const events = t.master.store.listEvents(run.id).length;
    for (const body of [
      '/ares1 approve',
      '/ares1 reject 不行',
      '/ares1 confirm',
      '/ares1 resume',
    ]) {
      issue.comments.push(body);
      await t.master.issues.poll();
      const reply = issue.comments.at(-1) ?? '';
      expect(reply).toContain(
        `@me 的 \`${body.split(' ').slice(0, 2).join(' ')}\` 现在不适用，没有执行。`,
      );
      expect(reply).toContain(
        'Run 卡住了。在这个 issue 上现在可以：评论第一行写 `/ares1 retry [说明]` 重试（说明会交给 Agent），写 `/ares1 cancel` 终止 Run。',
      );
    }
    const now = t.master.store.getRun(run.id);
    expect(now.status).toBe('blocked');
    expect(now.blocked).toEqual(run.blocked);
    expect(t.master.store.listEvents(run.id)).toHaveLength(events);
    expect(coderPrompts(t)).toHaveLength(1);
  });

  it('takes no retry written for a block that came back before the issue said so', async () => {
    const t = await start(STUCK_WORKFLOW);
    failingCoder(t, 2);
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'blocked');
    const issue = gh.get(1);
    issue.comments.push('/ares1 retry 早先的');
    // Retried on the dashboard and stuck again before the next poll.
    await t.master.engine.retry(run.id, {}, { source: 'dashboard' });
    await waitFor(() => coderPrompts(t).length === 2, 'second coding');
    await t.waitStatus(run.id, 'blocked');
    expect(t.master.store.getRun(run.id).issueSynced).toBeNull();

    await t.master.issues.poll();
    // The issue says the Run is stuck again; the command before it is not read.
    expect(issue.comments.at(-1)).toContain('Run 卡住了，需要你处理');
    expect(issue.comments.filter((c) => c.includes('Run 卡住了'))).toHaveLength(2);
    await t.master.issues.poll();
    expect(retries(t, run.id).map((e) => e.data.source)).toEqual(['dashboard']);
    expect(t.master.store.getRun(run.id).status).toBe('blocked');

    issue.comments.push('/ares1 retry');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'waiting_approval');
    expect(retries(t, run.id).map((e) => e.data.source)).toEqual(['dashboard', 'issue']);
  });

  it('retries once, even when the Master stopped before answering', async () => {
    const t = await start(STUCK_WORKFLOW);
    failingCoder(t, 99);
    gh.add({ title: '加 feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'blocked');
    const issue = gh.get(1);
    issue.comments.push('/ares1 retry 再试一次');
    // The answer never reaches the issue, as if the Master had stopped right after retrying.
    gh.failing.set('comment #1', 'connection reset');
    await t.master.issues.poll();
    expect(retries(t, run.id)).toHaveLength(1);
    await waitFor(() => coderPrompts(t).length === 2, 'second coding');
    await t.waitStatus(run.id, 'blocked');
    expect(issue.comments.at(-1)).toBe('/ares1 retry 再试一次');
    await t.close();
    h = undefined;
    gh.failing.clear();

    const again = await restart(t);
    again.scripts.coder = () => ({ finalMessage: '没写完' });
    await again.master.issues.poll();
    // The issue says the Run is stuck again before a command is read for it: the earlier one is
    // not.
    expect(issue.comments.at(-1)).toContain('Run 卡住了，需要你处理');
    await again.master.issues.poll();
    expect(retries(again, run.id)).toHaveLength(1);
    expect(again.master.store.getRun(run.id).status).toBe('blocked');
    expect(again.fake.calls).toEqual([]);
  });

  it('answers in English, with no Chinese left', async () => {
    const t = await start(
      STUCK_WORKFLOW.replace('测试流程', 'Test flow').replace('编码', 'Coding'),
      `language: en\n${CONFIG}`,
    );
    failingCoder(t, 1);
    gh.add({ title: 'Add a feature', body: 'feature.txt', labels: [LABELS.ready] });
    await t.master.issues.poll();
    const run = await runOfIssue(t, 'blocked');
    const issue = gh.get(1);
    const stuck = issue.comments.at(-1) ?? '';
    expect(stuck).toContain(
      'Handle it on the dashboard, or reply on this issue: start a comment with `/ares1 retry [note]` to retry (the note goes to the agent), or `/ares1 cancel` to cancel the Run.',
    );
    const from = issue.comments.length - 1;
    issue.comments.push('/ares1 resume');
    await t.master.issues.poll();
    issue.comments.push('/ares1 retry Name it feature.txt');
    await t.master.issues.poll();
    await t.waitStatus(run.id, 'waiting_approval');
    expect(coderPrompts(t)[1]).toContain('Note from a human: Name it feature.txt');
    const replies = issue.comments.slice(from).filter(isMasterComment);
    for (const reply of replies) expect(reply).not.toMatch(CJK);
    const text = replies.join('\n');
    expect(text).toContain("@me's `/ares1 resume` does not apply now, so it was not carried out.");
    expect(text).toContain('@me retried the Run with `/ares1 retry`, and it is queued again.');
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
