import { describe, expect, it } from 'vitest';
import type { ElectionStatus } from '../../charters/reads';
import { base58Encode } from '../../model/bytes';
import type { Contest } from '../../model/contest';
import { contenderTeamName, phaseTone, proposalStanding, standingChip, teamName, viewerNote, winningScore } from './standing';

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
    expect(proposalStanding(decided, { id: 'P-bob-2', leaderId: 'bob' })).toEqual({ kind: 'other-proposal' });
    expect(proposalStanding(decided, { id: 'P-carol', leaderId: 'carol' })).toEqual({ kind: 'closed' });
  });

  it('should say unknown when the team or contest read failed, not "not applied"', () => {
    const failed = { contest: undefined, failures: [{ source: 'the contest for the seat', message: 'x' }] };
    expect(proposalStanding(failed, { id: 'P-alice', leaderId: 'alice' })).toEqual({ kind: 'unknown' });
    expect(proposalStanding({ timing: { phase: 'unknown' } }, { id: 'P', leaderId: 'a' })).toEqual({ kind: 'unknown' });
  });

  it('should close non-applicants once the join window has closed', () => {
    const voting = { contest: contest([['alice', 4], ['bob', 2]]), timing: { phase: 'voting' as const } };
    expect(proposalStanding(voting, { id: 'P-carol', leaderId: 'carol' })).toEqual({ kind: 'closed' });
  });

  it("should tell a running leader's proposals apart by the application's proposal", () => {
    const id = (n: number) => base58Encode(Uint8Array.from({ length: 32 }, () => n));
    const running = contest([[id(1), 4]]);
    running.tally.contenders[0].document = { $ownerId: id(1), submittedCharterId: id(2) };
    const status = { contest: running, timing: { phase: 'join-window' as const } };
    expect(proposalStanding(status, { id: id(2), leaderId: id(1) })).toMatchObject({ kind: 'applied' });
    // Still in the join window: not "applications are now closed", but "applied with another".
    expect(proposalStanding(status, { id: id(3), leaderId: id(1) })).toEqual({ kind: 'other-proposal' });
    expect(viewerNote({ standing: { kind: 'other-proposal' }, role: 'leader' }).text).toMatch(/another of your proposals/);
    expect(viewerNote({ standing: { kind: 'other-proposal' }, role: 'other' }).text).not.toMatch(/closed/);
    expect(standingChip({ kind: 'other-proposal' }).text).toBe('leader applied with another');
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
    expect(viewerNote({ standing: { kind: 'seated' }, role: 'joiner' }).text).not.toMatch(/did not list you/);
    expect(viewerNote({ standing: { kind: 'not-applied' }, role: 'other' }).text).toMatch(/not applied/);
  });

  it('should colour phases', () => {
    expect(phaseTone('seated')).toBe('won');
    expect(phaseTone('join-window')).toBe('live');
    expect(phaseTone('not-elected')).toBe('muted');
  });
});

describe('winningScore', () => {
  it('should put the winner first, or say unopposed', () => {
    const c = [{ identityId: 'alice', votes: 4 }, { identityId: 'bob', votes: 12 }];
    expect(winningScore(c, 'bob')).toBe('12–4');
    expect(winningScore([{ identityId: 'bob', votes: 0 }], 'bob')).toBe('unopposed');
    expect(winningScore(c, 'carol')).toBeUndefined();
  });
});

describe('contenderTeamName', () => {
  const proposal = (id: string, leaderId: string, description: string, createdAtMs = 1) => ({
    id,
    leaderId,
    targetContractId: 'T',
    description,
    reasonIds: [],
    moderatorsShare: 100,
    createdAtMs,
  });
  const decidedContest = { ...contest([['bob', 12], ['alice', 4]], 'bob') };
  decidedContest.winner = { kind: 'identity', identityId: 'bob', rawKind: 'WonByIdentity', decidedAtMs: 100 };
  const status = {
    targetContractId: 'T',
    team,
    contest: decidedContest,
    proposals: [
      proposal('P-bob', 'bob', 'Team B. We keep threads on topic.'),
      proposal('P-alice-old', 'alice', 'Old team A.', 10),
      proposal('P-alice', 'alice', 'Team A. We remove spam.', 50),
      proposal('P-alice-late', 'alice', 'Too late.', 200),
    ],
  };

  it("should name the seated team by its charter's title, and a loser by its latest proposal before the decision", () => {
    expect(contenderTeamName(status, 'bob')).toBe('Team B');
    expect(contenderTeamName(status, 'alice')).toBe('Team A');
  });

  it('should give nothing for someone with no proposal read, or an empty charter', () => {
    expect(contenderTeamName(status, 'carol')).toBeUndefined();
    expect(teamName('  ')).toBeUndefined();
    expect(teamName('Clean feeds! We remove spam.')).toBe('Clean feeds');
  });

  it("should not guess the seated team's name when its proposal is past a capped list", () => {
    const capped = { ...status, proposals: status.proposals.filter((p) => p.id !== 'P-bob').concat(proposal('P-bob-2', 'bob', 'Other.', 50)) };
    expect(contenderTeamName(capped, 'bob')).toBeUndefined();
  });
});
