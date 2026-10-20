import { describe, expect, it } from 'vitest';
import type { ElectionStatus } from '../../charters/reads';
import type { Contest } from '../../model/contest';
import { phaseTone, proposalStanding, standingChip, viewerNote } from './standing';

const contest = (contenders: Array<[string, number]>, winner?: string): Contest =>
  ({
    tally: {
      contenders: contenders.map(([identityId, votes]) => ({ identityId, votes })),
      abstain: 0,
      lock: 0,
      total: contenders.reduce((a, [, v]) => a + v, 0),
    },
    winner: winner ? { kind: 'identity', identityId: winner, rawKind: 'WonByIdentity' } : undefined,
  }) as Contest;

const team = { electedCharterId: 'E', submittedCharterId: 'P-bob', leaderId: 'bob', members: [], electedMembers: [] };

describe('proposalStanding', () => {
  const decided: Pick<ElectionStatus, 'team' | 'contest'> = { team, contest: contest([['bob', 12], ['alice', 4]], 'bob') };

  it('should mark the seated proposal won, a losing contender lost with its share', () => {
    expect(proposalStanding(decided, { id: 'P-bob', leaderId: 'bob' })).toEqual({ kind: 'seated', votes: 12, share: 75 });
    expect(proposalStanding(decided, { id: 'P-alice', leaderId: 'alice' })).toEqual({ kind: 'lost', votes: 4, share: 25 });
  });

  it('should not call the seated leader\'s other proposals lost, nor non-applicants applied', () => {
    expect(proposalStanding(decided, { id: 'P-bob-2', leaderId: 'bob' })).toEqual({ kind: 'closed' });
    expect(proposalStanding(decided, { id: 'P-carol', leaderId: 'carol' })).toEqual({ kind: 'closed' });
  });

  it('should show running and not-yet-applied proposals while open', () => {
    const open = { contest: contest([['alice', 4]]) };
    expect(proposalStanding(open, { id: 'P-alice', leaderId: 'alice' })).toMatchObject({ kind: 'applied', votes: 4 });
    expect(proposalStanding({}, { id: 'P-carol', leaderId: 'carol' })).toEqual({ kind: 'not-applied' });
  });
});

describe('standingChip and viewerNote', () => {
  it('should word each standing for chips and for each viewer', () => {
    expect(standingChip({ kind: 'lost', votes: 4 }).text).toBe('lost · 4 votes');
    expect(standingChip({ kind: 'seated' }).tone).toBe('won');
    expect(viewerNote({ standing: { kind: 'lost', votes: 4, share: 25 }, role: 'leader' }).text).toMatch(/Your team lost with 4 votes \(25%\)/);
    expect(viewerNote({ standing: { kind: 'seated' }, role: 'joiner', onSeatedTeam: false }).text).toMatch(/did not list you/);
    expect(viewerNote({ standing: { kind: 'not-applied' }, role: 'other' }).text).toMatch(/not applied/);
  });

  it('should colour phases', () => {
    expect(phaseTone('seated')).toBe('won');
    expect(phaseTone('join-window')).toBe('live');
    expect(phaseTone('not-elected')).toBe('muted');
  });
});
