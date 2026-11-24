import { afterEach, describe, expect, it } from 'vitest';
import {
  assessedSize,
  assessmentProblem,
  assessmentRounds,
  conclusionLabel,
  conclusionOf,
  formatAssessment,
  formatReplyTimeout,
  hasHumanReply,
  humanReplies,
  pendingTimeout,
  type ReportedAssessment,
  replyDeadline,
  takeAssessment,
  verdictLabel,
  waitText,
} from '../src/engine/discussion.js';
import { setLang } from '../src/i18n.js';
import type {
  AssessmentEntry,
  AssessVerdict,
  DiscussionEntry,
  ReplyEntry,
  ReplyTimeoutEntry,
} from '../src/store/types.js';

afterEach(() => setLang('zh'));

const CJK = /[一-鿿]/;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-20T08:00:00.000Z');
/** Time `h` hours after T0, as ISO. */
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

function assessor(verdict: AssessVerdict, extra: Partial<AssessmentEntry> = {}): AssessmentEntry {
  return {
    role: 'assessor',
    verdict,
    summary: `${verdict} summary`,
    questions: verdict === 'ask' ? ['Which one?'] : [],
    suggestions: [],
    revisedGoal: null,
    proposedDrop: false,
    stageRunId: 'sr-old',
    at: at(0),
    ...extra,
  };
}

function human(text = 'Do it this way', when = at(1)): ReplyEntry {
  return { role: 'human', text, source: 'issue', at: when };
}

function timeout(hours = 24, when = at(24)): ReplyTimeoutEntry {
  return { role: 'timeout', hours, at: when };
}

function report(
  verdict: AssessVerdict,
  extra: Partial<ReportedAssessment> = {},
): ReportedAssessment {
  return { verdict, summary: 'My view', questions: [], suggestions: [], ...extra };
}

const where = { stageRunId: 'sr-new', at: at(30) };

describe('takeAssessment', () => {
  describe('before any human reply', () => {
    const histories: [string, DiscussionEntry[]][] = [
      ['first round', []],
      ['after questions nobody answered yet', [assessor('ask')]],
    ];

    for (const [name, discussion] of histories) {
      it(`turns drop into ask, marked as a proposed drop (${name})`, () => {
        const entry = takeAssessment(report('drop'), discussion, where);
        expect(entry.verdict).toBe('ask');
        expect(entry.proposedDrop).toBe(true);
        expect(entry.revisedGoal).toBeNull();
        expect(entry).not.toHaveProperty('decidedAlone');
      });

      it(`ignores a changed goal on go (${name})`, () => {
        const entry = takeAssessment(
          report('go', { revisedGoal: 'Something else' }),
          discussion,
          where,
        );
        expect(entry.verdict).toBe('go');
        expect(entry.proposedDrop).toBe(false);
        expect(entry.revisedGoal).toBeNull();
        expect(entry).not.toHaveProperty('decidedAlone');
      });

      it(`keeps ask as it is (${name})`, () => {
        const entry = takeAssessment(
          report('ask', { revisedGoal: 'Maybe this' }),
          discussion,
          where,
        );
        expect(entry.verdict).toBe('ask');
        expect(entry.proposedDrop).toBe(false);
        expect(entry.revisedGoal).toBeNull();
        expect(entry).not.toHaveProperty('decidedAlone');
      });
    }

    it('records the whole entry: trimmed summary, the lists as given, where and when', () => {
      const entry = takeAssessment(
        {
          verdict: 'ask',
          summary: '  \n Unclear which page.\n  ',
          questions: ['Which page?', 'Which language?'],
          suggestions: ['Start with the home page'],
        },
        [],
        where,
      );
      expect(entry).toEqual({
        role: 'assessor',
        verdict: 'ask',
        summary: 'Unclear which page.',
        questions: ['Which page?', 'Which language?'],
        suggestions: ['Start with the home page'],
        revisedGoal: null,
        proposedDrop: false,
        stageRunId: 'sr-new',
        at: at(30),
      });
    });

    it('records the size with any verdict, and none when not given', () => {
      expect(takeAssessment(report('go', { size: 'L' }), [], where).size).toBe('L');
      expect(takeAssessment(report('ask', { size: 'S' }), [], where).size).toBe('S');
      const proposedDrop = takeAssessment(report('drop', { size: 'M' }), [], where);
      expect(proposedDrop).toMatchObject({ verdict: 'ask', proposedDrop: true, size: 'M' });
      expect(takeAssessment(report('go'), [], where)).not.toHaveProperty('size');
    });
  });

  describe('after a human reply', () => {
    const discussion = [assessor('ask'), human()];

    it('takes drop as drop', () => {
      const entry = takeAssessment(report('drop'), discussion, where);
      expect(entry.verdict).toBe('drop');
      expect(entry.proposedDrop).toBe(false);
      expect(entry).not.toHaveProperty('decidedAlone');
    });

    it('takes the changed goal of go, trimmed', () => {
      const entry = takeAssessment(
        report('go', { revisedGoal: '\n  The revised requirement.  \n' }),
        discussion,
        where,
      );
      expect(entry.verdict).toBe('go');
      expect(entry.revisedGoal).toBe('The revised requirement.');
      expect(entry.proposedDrop).toBe(false);
      expect(entry).not.toHaveProperty('decidedAlone');
    });

    it('takes an empty or blank changed goal as none', () => {
      for (const revisedGoal of [undefined, '', '   \n  ']) {
        const entry = takeAssessment(report('go', { revisedGoal }), discussion, where);
        expect(entry.revisedGoal).toBeNull();
      }
    });

    it('ignores a changed goal unless the verdict is go', () => {
      for (const verdict of ['ask', 'drop'] as const) {
        const entry = takeAssessment(report(verdict, { revisedGoal: 'Other' }), discussion, where);
        expect(entry.verdict).toBe(verdict);
        expect(entry.revisedGoal).toBeNull();
      }
    });

    it('counts a reply from earlier rounds too', () => {
      const later = [assessor('ask'), human(), assessor('ask', { at: at(2) })];
      const entry = takeAssessment(report('drop'), later, where);
      expect(entry.verdict).toBe('drop');
      expect(entry.proposedDrop).toBe(false);
    });

    it('counts a reply that came after an earlier timeout', () => {
      const late = [assessor('ask'), timeout(), human('Sorry, late', at(25))];
      const entry = takeAssessment(report('go', { revisedGoal: 'Changed' }), late, where);
      expect(entry.verdict).toBe('go');
      expect(entry.revisedGoal).toBe('Changed');
      expect(entry).not.toHaveProperty('decidedAlone');
    });
  });

  describe('after nobody replied in time', () => {
    const histories: [string, DiscussionEntry[]][] = [
      ['nobody ever replied', [assessor('ask'), timeout()]],
      ['the stage does not wait', [assessor('ask'), timeout(0)]],
      [
        'a human replied in an earlier round',
        [assessor('ask'), human(), assessor('ask', { at: at(2) }), timeout(24, at(26))],
      ],
    ];

    for (const [name, discussion] of histories) {
      it(`takes drop as drop, decided alone (${name})`, () => {
        const entry = takeAssessment(report('drop'), discussion, where);
        expect(entry.verdict).toBe('drop');
        expect(entry.proposedDrop).toBe(false);
        expect(entry.decidedAlone).toBe(true);
      });

      it(`takes go decided alone and ignores a changed goal (${name})`, () => {
        const entry = takeAssessment(report('go', { revisedGoal: 'Changed' }), discussion, where);
        expect(entry.verdict).toBe('go');
        expect(entry.revisedGoal).toBeNull();
        expect(entry.proposedDrop).toBe(false);
        expect(entry.decidedAlone).toBe(true);
      });

      it(`does not mark ask as decided alone (${name})`, () => {
        const entry = takeAssessment(report('ask'), discussion, where);
        expect(entry.verdict).toBe('ask');
        expect(entry.proposedDrop).toBe(false);
        expect(entry).not.toHaveProperty('decidedAlone');
      });
    }
  });
});

describe('assessmentProblem', () => {
  it('accepts every verdict while no timeout is pending', () => {
    const histories: DiscussionEntry[][] = [
      [],
      [assessor('ask')],
      [assessor('ask'), human()],
      [assessor('ask'), timeout(), human('Late', at(25))],
      [assessor('ask'), timeout(), assessor('go', { decidedAlone: true, at: at(25) })],
    ];
    for (const discussion of histories) {
      for (const verdict of ['go', 'ask', 'drop'] as const) {
        expect(assessmentProblem({ verdict }, discussion)).toBeNull();
      }
    }
  });

  it('accepts go and drop after a timeout', () => {
    for (const hours of [0, 24]) {
      const discussion = [assessor('ask'), timeout(hours)];
      expect(assessmentProblem({ verdict: 'go' }, discussion)).toBeNull();
      expect(assessmentProblem({ verdict: 'drop' }, discussion)).toBeNull();
    }
  });

  it('refuses ask after nobody replied within the wait', () => {
    const problem = assessmentProblem({ verdict: 'ask' }, [assessor('ask'), timeout(24)]);
    expect(problem).toMatch(/^24 小时内没有人回复，这一轮不能再给 ask/);
    expect(problem).toContain('go');
    expect(problem).toContain('drop');
  });

  it('refuses ask when the stage does not wait for replies', () => {
    const problem = assessmentProblem({ verdict: 'ask' }, [assessor('ask'), timeout(0)]);
    expect(problem).toMatch(/^这个阶段不等人回复，这一轮不能再给 ask/);
  });

  it('says why in English', () => {
    setLang('en');
    const waited = assessmentProblem({ verdict: 'ask' }, [assessor('ask'), timeout(24)]);
    expect(waited).toMatch(/^Nobody replied within 24 hours, so this round may not give ask again/);
    const short = assessmentProblem({ verdict: 'ask' }, [assessor('ask'), timeout(0.5)]);
    expect(short).toMatch(/^Nobody replied within 30 minutes, /);
    const noWait = assessmentProblem({ verdict: 'ask' }, [assessor('ask'), timeout(0)]);
    expect(noWait).toMatch(/^This stage does not wait for replies, so this round may not give ask/);
    for (const text of [waited, short, noWait]) expect(text).not.toMatch(CJK);
  });
});

describe('the discussion so far', () => {
  const ask1 = assessor('ask', { at: at(0) });
  const reply1 = human('First', at(1));
  const ask2 = assessor('ask', { at: at(2) });
  const reply2 = human('Second', at(3));
  const go = assessor('go', { at: at(4) });
  const wait = timeout(24, at(26));

  it('hasHumanReply: whether any human replied', () => {
    expect(hasHumanReply([])).toBe(false);
    expect(hasHumanReply([ask1])).toBe(false);
    expect(hasHumanReply([ask1, wait])).toBe(false);
    expect(hasHumanReply([ask1, reply1])).toBe(true);
    expect(hasHumanReply([ask1, reply1, ask2])).toBe(true);
  });

  it('humanReplies: the replies in order', () => {
    expect(humanReplies([])).toEqual([]);
    expect(humanReplies([ask1, wait])).toEqual([]);
    const replies = humanReplies([ask1, reply1, ask2, reply2, go]);
    expect(replies).toHaveLength(2);
    expect(replies[0]).toBe(reply1);
    expect(replies[1]).toBe(reply2);
  });

  it('assessmentRounds: the rounds in order', () => {
    expect(assessmentRounds([])).toEqual([]);
    const rounds = assessmentRounds([ask1, reply1, ask2, reply2, go]);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]).toBe(ask1);
    expect(rounds[1]).toBe(ask2);
    expect(rounds[2]).toBe(go);
  });

  it('conclusionOf: the latest round when it concluded', () => {
    expect(conclusionOf([])).toBeNull();
    expect(conclusionOf([ask1])).toBeNull();
    expect(conclusionOf([ask1, reply1])).toBeNull();
    expect(conclusionOf([ask1, reply1, go])).toBe(go);
    // Replies after the conclusion do not undo it.
    expect(conclusionOf([ask1, reply1, go, reply2])).toBe(go);
    const drop = assessor('drop', { at: at(5) });
    expect(conclusionOf([ask1, reply1, drop])).toBe(drop);
    // A later round that asks again replaces an earlier conclusion.
    expect(conclusionOf([go, reply1, ask2])).toBeNull();
  });

  it('assessedSize: the size of the latest go round', () => {
    expect(assessedSize([])).toBeUndefined();
    // Sizes of rounds that did not go ahead decide nothing.
    const askL = assessor('ask', { size: 'L' });
    expect(assessedSize([askL, reply1])).toBeUndefined();
    expect(assessedSize([assessor('drop', { size: 'L' })])).toBeUndefined();
    // A go without a size (left out, or recorded before sizes) has none.
    expect(assessedSize([askL, reply1, go])).toBeUndefined();
    const goM = assessor('go', { size: 'M', at: at(4) });
    const goL = assessor('go', { size: 'L', at: at(6) });
    expect(assessedSize([askL, reply1, goM])).toBe('M');
    expect(assessedSize([goM, reply2])).toBe('M');
    expect(assessedSize([goM, reply2, goL])).toBe('L');
    expect(assessedSize([goL, reply2, go])).toBeUndefined();
    // The latest go counts even when a later round asks again.
    expect(assessedSize([goL, reply2, ask2])).toBe('L');
  });

  it('pendingTimeout: only when the discussion ends with a timeout', () => {
    expect(pendingTimeout([])).toBeUndefined();
    expect(pendingTimeout([ask1])).toBeUndefined();
    expect(pendingTimeout([ask1, reply1])).toBeUndefined();
    expect(pendingTimeout([ask1, wait])).toBe(wait);
    expect(pendingTimeout([ask1, wait, reply2])).toBeUndefined();
    expect(pendingTimeout([ask1, wait, assessor('go', { decidedAlone: true })])).toBeUndefined();
  });
});

describe('replyDeadline', () => {
  it('is the latest questions plus the wait', () => {
    expect(replyDeadline([assessor('ask', { at: at(0) })], 24)).toBe(T0 + 24 * HOUR);
    expect(replyDeadline([assessor('ask', { at: at(0) })], 0.5)).toBe(T0 + HOUR / 2);
    const later = [assessor('ask', { at: at(0) }), human(), assessor('ask', { at: at(5) })];
    expect(replyDeadline(later, 24)).toBe(T0 + 29 * HOUR);
  });

  it('is the questions themselves when the stage does not wait', () => {
    expect(replyDeadline([assessor('ask', { at: at(3) })], 0)).toBe(T0 + 3 * HOUR);
  });

  it('is null when the stage waits however long it takes', () => {
    expect(replyDeadline([assessor('ask')], null)).toBeNull();
  });

  it('is null unless the discussion ends with questions', () => {
    const cases: DiscussionEntry[][] = [
      [],
      [assessor('go')],
      [assessor('drop')],
      [assessor('ask'), human()],
      [assessor('ask'), timeout()],
      [assessor('ask'), human(), assessor('go', { at: at(2) })],
    ];
    for (const discussion of cases) expect(replyDeadline(discussion, 24)).toBeNull();
  });
});

describe('waitText', () => {
  it('says hours from one hour on, to one decimal', () => {
    expect(waitText(1)).toBe('1 小时');
    expect(waitText(24)).toBe('24 小时');
    expect(waitText(1.5)).toBe('1.5 小时');
    expect(waitText(1.04)).toBe('1 小时');
    setLang('en');
    expect(waitText(1)).toBe('1 hour');
    expect(waitText(1.04)).toBe('1 hour');
    expect(waitText(1.5)).toBe('1.5 hours');
    expect(waitText(24)).toBe('24 hours');
  });

  it('says minutes below one hour, at least one', () => {
    expect(waitText(0.5)).toBe('30 分钟');
    expect(waitText(1 / 60)).toBe('1 分钟');
    expect(waitText(0.001)).toBe('1 分钟');
    setLang('en');
    expect(waitText(0.5)).toBe('30 minutes');
    expect(waitText(0.25)).toBe('15 minutes');
    expect(waitText(1 / 60)).toBe('1 minute');
    expect(waitText(0.001)).toBe('1 minute');
  });
});

describe('verdictLabel', () => {
  it('names each verdict in both languages', () => {
    expect(verdictLabel('go')).toBe('开工');
    expect(verdictLabel('ask')).toBe('需要讨论');
    expect(verdictLabel('drop')).toBe('不做');
    setLang('en');
    expect(verdictLabel('go')).toBe('Go ahead');
    expect(verdictLabel('ask')).toBe('Needs discussion');
    expect(verdictLabel('drop')).toBe('Drop');
  });
});

describe('conclusionLabel', () => {
  const cases: [
    Pick<AssessmentEntry, 'verdict' | 'revisedGoal' | 'decidedAlone'>,
    string,
    string,
  ][] = [
    [{ verdict: 'drop', revisedGoal: null }, '不做', 'Drop'],
    [{ verdict: 'drop', revisedGoal: null, decidedAlone: false }, '不做', 'Drop'],
    [
      { verdict: 'drop', revisedGoal: null, decidedAlone: true },
      '没人回复，评估决定不做',
      'Drop, decided by the assessment as nobody replied',
    ],
    [
      { verdict: 'go', revisedGoal: null },
      '按原需求开工',
      'Go ahead with the original requirement',
    ],
    [
      { verdict: 'go', revisedGoal: 'New goal' },
      '按讨论后修改的需求开工',
      'Go ahead with the requirement as revised in the discussion',
    ],
    [
      { verdict: 'go', revisedGoal: null, decidedAlone: true },
      '没人回复，按评估的假设开工',
      "Go ahead on the assessment's assumptions, as nobody replied",
    ],
    // Deciding alone wins over a changed goal (takeAssessment never records both).
    [
      { verdict: 'go', revisedGoal: 'New goal', decidedAlone: true },
      '没人回复，按评估的假设开工',
      "Go ahead on the assessment's assumptions, as nobody replied",
    ],
    [{ verdict: 'ask', revisedGoal: null }, '需要讨论', 'Needs discussion'],
  ];

  it('names each conclusion in Chinese', () => {
    for (const [entry, zh] of cases) expect(conclusionLabel(entry)).toBe(zh);
  });

  it('names each conclusion in English', () => {
    setLang('en');
    for (const [entry, , en] of cases) {
      expect(conclusionLabel(entry)).toBe(en);
      expect(conclusionLabel(entry)).not.toMatch(CJK);
    }
  });
});

describe('formatReplyTimeout', () => {
  it('names the wait, or that there is none', () => {
    expect(formatReplyTimeout(timeout(24)).title).toBe('24 小时内没有人回复');
    expect(formatReplyTimeout(timeout(0.5)).title).toBe('30 分钟内没有人回复');
    expect(formatReplyTimeout(timeout(0)).title).toBe('不等人回复');
    expect(formatReplyTimeout(timeout(24)).text).toContain('reply_timeout_hours');
  });

  it('in English', () => {
    setLang('en');
    const waited = formatReplyTimeout(timeout(24));
    expect(waited.title).toBe('Nobody replied within 24 hours');
    expect(formatReplyTimeout(timeout(1)).title).toBe('Nobody replied within 1 hour');
    expect(formatReplyTimeout(timeout(0.5)).title).toBe('Nobody replied within 30 minutes');
    const noWait = formatReplyTimeout(timeout(0));
    expect(noWait.title).toBe('Not waiting for replies');
    expect(waited.text).toContain('reply_timeout_hours');
    for (const { title, text } of [waited, noWait]) {
      expect(title).not.toMatch(CJK);
      expect(text).not.toMatch(CJK);
    }
  });
});

describe('formatAssessment', () => {
  const full = assessor('go', {
    summary: 'Looks fine.',
    questions: ['Which page?', 'Which language?'],
    suggestions: ['Start small', 'Add tests'],
    revisedGoal: 'Do the home page first.',
  });

  it('is the summary alone when there is nothing else', () => {
    expect(formatAssessment(assessor('go', { summary: 'Just do it.' }))).toBe('Just do it.');
  });

  it('adds the questions, suggestions and changed requirement in Chinese', () => {
    expect(formatAssessment(full)).toBe(
      [
        'Looks fine.',
        '疑问和顾虑：\n1. Which page?\n2. Which language?',
        '建议：\n- Start small\n- Add tests',
        '修改后的需求：\n\nDo the home page first.',
      ].join('\n\n'),
    );
  });

  it('adds only the parts there are', () => {
    expect(formatAssessment(assessor('ask', { summary: 'Unclear.', questions: ['Why?'] }))).toBe(
      'Unclear.\n\n疑问和顾虑：\n1. Why?',
    );
    expect(
      formatAssessment(assessor('ask', { summary: 'Hmm.', questions: [], suggestions: ['Split'] })),
    ).toBe('Hmm.\n\n建议：\n- Split');
  });

  it('in English', () => {
    setLang('en');
    const text = formatAssessment(full);
    expect(text).toBe(
      [
        'Looks fine.',
        'Questions and concerns:\n1. Which page?\n2. Which language?',
        'Suggestions:\n- Start small\n- Add tests',
        'Revised requirement:\n\nDo the home page first.',
      ].join('\n\n'),
    );
    expect(text).not.toMatch(CJK);
  });
});
