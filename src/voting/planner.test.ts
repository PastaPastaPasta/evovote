import { describe, expect, it } from 'vitest';
import type { VoteChoice } from '../model/contest';
import { planVotes, VOTES_PER_POLL, type PlanInput, type PlanPoll } from './planner';

const ALICE = 'AliceIdentity1111111111111111111111111111111';
const BOB = 'BobIdentity11111111111111111111111111111111';

const dpnsPoll: PlanPoll = {
  keyString: 'dpns-key',
  allowedChoices: ['identity', 'abstain', 'lock'],
  contenderIds: [ALICE, BOB],
  votable: true,
};
const charterPoll: PlanPoll = {
  keyString: 'charter-key',
  allowedChoices: ['identity', 'abstain'], // resolution 1: no Lock
  contenderIds: [ALICE],
  votable: true,
};

const mn = (id: string, hasKey = true) => ({ id, proTxHash: `${id}-protx`, hasKey });

function input(overrides: Partial<PlanInput>): PlanInput {
  return {
    polls: [dpnsPoll],
    masternodes: [mn('a')],
    choice: { type: 'identity', identityId: ALICE },
    currentVotes: new Map([['a', new Map()]]),
    sentCount: () => 0,
    ...overrides,
  };
}

describe('planVotes', () => {
  it('should cast for every masternode × poll pair that needs it', () => {
    const plan = planVotes(
      input({
        polls: [dpnsPoll, { ...dpnsPoll, keyString: 'other' }],
        masternodes: [mn('a'), mn('b')],
        currentVotes: new Map([
          ['a', new Map()],
          ['b', new Map()],
        ]),
      }),
    );
    expect(plan).toHaveLength(4);
    expect(plan.every((i) => i.action === 'cast')).toBe(true);
  });

  it('should skip a no-op re-vote (40304) but cast a changed one', () => {
    const current = new Map<string, VoteChoice>([['dpns-key', { type: 'identity', identityId: ALICE }]]);
    const same = planVotes(input({ currentVotes: new Map([['a', current]]) }));
    expect(same[0]).toMatchObject({ action: 'skip', reason: 'no-op', votesUsedAtLeast: 1 });

    const changed = planVotes(
      input({
        currentVotes: new Map([['a', current]]),
        choice: { type: 'identity', identityId: BOB },
      }),
    );
    expect(changed[0]).toMatchObject({ action: 'cast', current: { type: 'identity', identityId: ALICE } });
  });

  it('should treat abstain/lock no-ops by type', () => {
    const current = new Map<string, VoteChoice>([['dpns-key', { type: 'abstain' }]]);
    expect(
      planVotes(input({ currentVotes: new Map([['a', current]]), choice: { type: 'abstain' } }))[0].reason,
    ).toBe('no-op');
    expect(
      planVotes(input({ currentVotes: new Map([['a', current]]), choice: { type: 'lock' } }))[0].action,
    ).toBe('cast');
  });

  it('should skip once the 5-vote budget is known to be spent', () => {
    const plan = planVotes(input({ sentCount: () => VOTES_PER_POLL }));
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'budget', votesUsedAtLeast: 5 });
    const four = planVotes(input({ sentCount: () => VOTES_PER_POLL - 1 }));
    expect(four[0].action).toBe('cast');
  });

  it('should never offer Lock on a resolution-1 poll', () => {
    const plan = planVotes(input({ polls: [charterPoll], choice: { type: 'lock' } }));
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'choice-not-allowed' });
  });

  it('should refuse a vote for a non-contender (40307)', () => {
    const plan = planVotes(input({ choice: { type: 'identity', identityId: 'Nobody' } }));
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'not-contender' });
  });

  it('should skip masternodes without a key and closed polls', () => {
    expect(planVotes(input({ masternodes: [mn('a', false)] }))[0].reason).toBe('no-key');
    expect(planVotes(input({ polls: [{ ...dpnsPoll, votable: false }] }))[0].reason).toBe('closed');
  });

  it('should still cast when the current vote could not be read, flagging it', () => {
    const plan = planVotes(input({ currentVotes: new Map([['a', undefined]]) }));
    expect(plan[0]).toMatchObject({ action: 'cast', currentUnknown: true });
  });
});
