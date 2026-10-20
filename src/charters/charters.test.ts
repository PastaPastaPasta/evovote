import { describe, expect, it } from 'vitest';
import { base58Encode } from '../model/bytes';
import {
  DEFAULT_WINDOW_SECONDS,
  durationText,
  electedOf,
  electionOpensAtMs,
  parseContractModeration,
} from './declaration';
import { charterApplicationView, charterTitle, targetName } from '../kinds/charter';
import { encodePollKey } from '../model/pollKey';
import { mergeDirectory } from './directory';
import { mergeReasons, pickLeaderProposal } from './reads';
import {
  idFromValue,
  splitText,
  toElectedCharter,
  toJoinRequestMeta,
  toProposal,
  toReason,
  type CharterProposal,
} from './documents';
import { canApply, electionTiming, joinClosesAt, LATE_APPLY_MARGIN_MS, type PhaseInput } from './phase';
import { charterPollKey, charterTarget, proposalHref } from './pollKey';
import {
  MAX_ELECTED_MEMBERS,
  splitNotes,
  validateCharter,
  validateJoinMessage,
  validateMembers,
  validateReason,
  validateRewardSplit,
} from './validate';

const TARGET = 'BGxVk266LDvQGTCFaDGXwpHHkU5MQYDTYNttxgiuAwDP';
const LEADER = '6WejZTMuQ7ZyWbSPg8LZqNnhw6nHaZ3o2ebRm6Fz1V5o';
const MEMBER = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));

/** A registered contract's JSON with an elected declaration (book wire shape). */
const electedContract = (moderators: Record<string, unknown>, createdAt: number | null = 1_790_000_000_000) => ({
  id: TARGET,
  createdAt,
  config: {
    moderation: {
      banlist: true,
      suspensions: true,
      warnings: false,
      moderators: {
        $type: 'elected',
        seatContestable: false,
        moderatedDocumentTypes: { post: ['ban', 'deleteDocuments'], reply: ['ban'] },
        interim: { $type: 'notYetUsable' },
        ...moderators,
      },
    },
  },
});

describe('declaration parsing', () => {
  it('should read an elected declaration with its windows, abilities and interim', () => {
    const m = parseContractModeration(
      electedContract({ joinWindow: 86400, voteWindow: 172800, electionDelay: 3600, maxAddedModerators: 10, ownerProtected: true }),
    );
    expect(m.lists).toEqual({ banlist: true, suspensions: true, warnings: false });
    expect(m.createdAtMs).toBe(1_790_000_000_000);
    expect(electedOf(m)).toEqual({
      joinWindowSeconds: 86400,
      voteWindowSeconds: 172800,
      electionDelaySeconds: 3600,
      maxAddedModerators: 10,
      moderatedDocumentTypes: { post: ['ban', 'deleteDocuments'], reply: ['ban'] },
      interim: { kind: 'notYetUsable', identities: [] },
      ownerProtected: true,
      seatContestable: false,
      challengeCoolDownSeconds: undefined,
    });
    expect(electionOpensAtMs(m)).toBe(1_790_000_000_000 + 3_600_000);
  });

  it('should default missing windows to one week and maxAdded to 0', () => {
    const e = electedOf(parseContractModeration(electedContract({})))!;
    expect(e.joinWindowSeconds).toBe(DEFAULT_WINDOW_SECONDS);
    expect(e.voteWindowSeconds).toBe(DEFAULT_WINDOW_SECONDS);
    expect(e.maxAddedModerators).toBe(0);
    expect(e.ownerProtected).toBe(false);
  });

  it('should keep 0-second windows (allowed off mainnet) instead of defaulting them', () => {
    const e = electedOf(parseContractModeration(electedContract({ joinWindow: 0, voteWindow: 0 })))!;
    expect(e.joinWindowSeconds).toBe(0);
    expect(e.voteWindowSeconds).toBe(0);
  });

  it('should read appointed interim moderators and a contestable seat', () => {
    const e = electedOf(
      parseContractModeration(
        electedContract({
          interim: { $type: 'appointedModerators', identities: [MEMBER] },
          seatContestable: true,
          challengeCoolDown: 1209600,
        }),
      ),
    )!;
    expect(e.interim).toEqual({ kind: 'appointedModerators', identities: [MEMBER] });
    expect(e.seatContestable).toBe(true);
    expect(e.challengeCoolDownSeconds).toBe(1209600);
  });

  it('should tell non-elected and unmoderated contracts apart', () => {
    expect(parseContractModeration({ config: {} }).declaration).toEqual({ kind: 'none' });
    expect(
      parseContractModeration({ config: { moderation: { banlist: true, moderators: { $type: 'contractOwner' } } } })
        .declaration,
    ).toEqual({ kind: 'contractOwner' });
    expect(
      parseContractModeration({
        config: { moderation: { moderators: { $type: 'appointedModerators', identities: [MEMBER] } } },
      }).declaration,
    ).toEqual({ kind: 'appointedModerators', identities: [MEMBER] });
    expect(parseContractModeration({ config: { moderation: { moderators: { $type: 'future' } } } }).declaration).toEqual({
      kind: 'unknown',
      rawType: 'future',
    });
    expect(parseContractModeration(null).declaration).toEqual({ kind: 'none' });
  });

  it('should never open an election with a delay and no recorded creation time', () => {
    const m = parseContractModeration(electedContract({ electionDelay: 60 }, null));
    expect(electionOpensAtMs(m)).toBe(Number.POSITIVE_INFINITY);
    expect(electionOpensAtMs(parseContractModeration(electedContract({})))).toBeUndefined();
  });

  it('should word durations', () => {
    expect(durationText(604800)).toBe('1 week');
    expect(durationText(1209600)).toBe('2 weeks');
    expect(durationText(86400)).toBe('1 day');
    expect(durationText(129600)).toBe('36 hours');
    expect(durationText(2700)).toBe('45 minutes');
    expect(durationText(90)).toBe('90 seconds');
    expect(durationText(0)).toBe('0 seconds');
  });
});

describe('charter documents', () => {
  it('should read identifiers in every form the SDK gives them', () => {
    const bytes = new Uint8Array(32).fill(7);
    const b58 = base58Encode(bytes);
    expect(idFromValue(b58)).toBe(b58);
    expect(idFromValue(bytes)).toBe(b58);
    expect(idFromValue(Array.from(bytes))).toBe(b58);
    expect(idFromValue(btoa(String.fromCharCode(...bytes)))).toBe(b58);
    expect(idFromValue({ toBase58: () => b58 })).toBe(b58);
    expect(idFromValue('short')).toBeUndefined();
    expect(idFromValue(new Uint8Array(20))).toBeUndefined();
    expect(idFromValue(null)).toBeUndefined();
  });

  it('should map a submittedCharter as read from chain', () => {
    const p = toProposal({
      $id: id32(1),
      $ownerId: LEADER,
      $createdAt: 1_790_000_000_000,
      targetContractId: TARGET,
      description: 'We moderate spam.',
      reasons: [id32(2), id32(3)],
      moderatorsShare: 60,
      rewardSplit: { leader: 40, equal: 30, actions: 30 },
    });
    expect(p).toEqual({
      id: id32(1),
      leaderId: LEADER,
      targetContractId: TARGET,
      description: 'We moderate spam.',
      reasonIds: [id32(2), id32(3)],
      moderatorsShare: 60,
      rewardSplit: { leader: 40, equal: 30, actions: 30 },
      createdAtMs: 1_790_000_000_000,
    });
    expect(splitText(p.rewardSplit)).toBe('leader 40% · equal 30% · by actions 30%');
  });

  it('should read an absent share as 100 and a broken split as unreadable', () => {
    const p = toProposal({ $ownerId: LEADER, rewardSplit: { leader: 50 } }, 'fallback');
    expect(p.id).toBe('fallback');
    expect(p.moderatorsShare).toBe(100);
    expect(p.rewardSplit).toBeUndefined();
    expect(splitText(undefined)).toBe('not readable');
  });

  it('should map reasons, elected charters and join request metadata', () => {
    expect(toReason({ $id: id32(2), $ownerId: LEADER, code: 'SPM', label: 'Spam' })).toEqual({
      id: id32(2),
      ownerId: LEADER,
      code: 'SPM',
      label: 'Spam',
    });
    expect(
      toElectedCharter({ $ownerId: LEADER, targetContractId: TARGET, submittedCharterId: id32(1), members: [MEMBER] }, 'x'),
    ).toMatchObject({ id: 'x', leaderId: LEADER, targetContractId: TARGET, submittedCharterId: id32(1), members: [MEMBER] });
    expect(
      toJoinRequestMeta({ $ownerId: MEMBER, submittedCharterId: id32(1), recipientKeyId: 5, senderKeyId: 6, encryptedMessage: 'zz' }, 'j'),
    ).toEqual({ id: 'j', memberId: MEMBER, submittedCharterId: id32(1), recipientKeyId: 5, senderKeyId: 6, createdAtMs: undefined });
  });

  it('should key a charter poll by an Identifier-typed target', () => {
    const key = charterPollKey(TARGET);
    expect(charterTarget(key)).toBe(TARGET);
    expect(charterTarget({ ...key, indexValues: [{ type: 'text', value: TARGET }] })).toBeUndefined();
    expect(proposalHref(TARGET, 'abc')).toBe(`#/m/${TARGET}/charter/abc`);
  });
});

describe('election phase', () => {
  const NOW = 1_800_000_000_000;
  const elected = parseContractModeration(electedContract({ joinWindow: 86400, voteWindow: 86400 }));
  const base: PhaseInput = { moderation: elected, seated: false, contest: undefined, proposals: 0 };

  it('should not claim a phase when a read it rests on failed', () => {
    expect(electionTiming({ ...base, moderation: 'failed' }, NOW).phase).toBe('unknown');
    expect(electionTiming({ ...base, seated: 'failed' }, NOW).phase).toBe('unknown');
    expect(electionTiming({ ...base, contest: 'failed' }, NOW).phase).toBe('unknown');
    expect(electionTiming({ ...base, proposals: 'failed' }, NOW).phase).toBe('unknown');
  });

  it('should walk from no election to proposals to seated', () => {
    expect(electionTiming({ ...base, moderation: parseContractModeration({}) }, NOW).phase).toBe('not-elected');
    expect(electionTiming({ ...base, moderation: undefined }, NOW).phase).toBe('not-elected');
    expect(electionTiming(base, NOW).phase).toBe('no-election');
    expect(electionTiming({ ...base, proposals: 2 }, NOW).phase).toBe('proposals');
    expect(electionTiming({ ...base, seated: true }, NOW).phase).toBe('seated');
    expect(electionTiming({ ...base, contest: { contenders: 2, hasWinner: true } }, NOW).phase).toBe('decided');
  });

  it('should hold applications during the election delay', () => {
    const delayed = parseContractModeration(electedContract({ electionDelay: 3600 }, NOW - 60_000));
    const t = electionTiming({ ...base, moderation: delayed, proposals: 1 }, NOW);
    expect(t.phase).toBe('notice');
    expect(t.opensAtMs).toBe(NOW - 60_000 + 3_600_000);
    expect(canApply(t, NOW)).toMatchObject({ ok: false, code: 40135 });
    expect(electionTiming({ ...base, moderation: delayed }, NOW + 3_600_000).phase).toBe('no-election');
  });

  it('should put a lone applicant\'s join close at the poll end', () => {
    expect(joinClosesAt(NOW, 1, 86400)).toBe(NOW);
    expect(joinClosesAt(NOW, 2, 86400)).toBe(NOW - 86_400_000);
    const t = electionTiming({ ...base, contest: { contenders: 1, hasWinner: false }, endsAtMs: NOW + 3_600_000 }, NOW);
    expect(t).toMatchObject({ phase: 'join-window', joinClosesAtMs: NOW + 3_600_000, endsAtMs: NOW + 3_600_000 });
  });

  it('should move to voting once a second applicant\'s join window has closed', () => {
    const two = { ...base, contest: { contenders: 2, hasWinner: false } };
    expect(electionTiming({ ...two, endsAtMs: NOW + 2 * 86_400_000 - 1 }, NOW).phase).toBe('join-window');
    const voting = electionTiming({ ...two, endsAtMs: NOW + 3_600_000 }, NOW);
    expect(voting.phase).toBe('voting');
    expect(canApply(voting, NOW)).toMatchObject({ ok: false, code: 40111 });
    expect(electionTiming({ ...two, endsAtMs: NOW - 1 }, NOW).phase).toBe('closing');
  });

  it('should refuse a seated or decided contract with 40105 and warn near the join close', () => {
    expect(canApply(electionTiming({ ...base, seated: true }, NOW), NOW)).toMatchObject({ ok: false, code: 40105 });
    expect(canApply({ phase: 'decided' }, NOW)).toMatchObject({ ok: false, code: 40105 });
    expect(canApply({ phase: 'not-elected' }, NOW)).toMatchObject({ ok: false, code: 40135 });
    expect(canApply({ phase: 'unknown' }, NOW).ok).toBe(false);
    expect(canApply({ phase: 'no-election' }, NOW)).toEqual({ ok: true });
    expect(canApply({ phase: 'join-window', joinClosesAtMs: NOW + LATE_APPLY_MARGIN_MS + 1 }, NOW)).toEqual({ ok: true });
    const late = canApply({ phase: 'join-window', joinClosesAtMs: NOW + 60_000 }, NOW);
    expect(late.ok && late.warning).toMatch(/40111/);
  });

  it('should refuse when an open contest\'s timing is unknown', () => {
    const t = electionTiming({ ...base, contest: { contenders: 1, hasWinner: false } }, NOW);
    expect(t.phase).toBe('voting');
    expect(canApply(t, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown/) });
  });

  it('should time the contest from the first application when the end-date index lacks it', () => {
    const lone = electionTiming({ ...base, contest: { contenders: 1, hasWinner: false }, firstAppliedAtMs: NOW - 3_600_000 }, NOW);
    expect(lone).toMatchObject({ phase: 'join-window', joinClosesAtMs: NOW - 3_600_000 + 86_400_000 });
    const two = electionTiming({ ...base, contest: { contenders: 2, hasWinner: false }, firstAppliedAtMs: NOW - 90_000_000 }, NOW);
    expect(two).toMatchObject({ phase: 'voting', endsAtMs: NOW - 90_000_000 + 2 * 86_400_000 });
    // The end-date index wins when it has the poll.
    expect(
      electionTiming({ ...base, contest: { contenders: 1, hasWinner: false }, firstAppliedAtMs: 0, endsAtMs: NOW + 1 }, NOW).endsAtMs,
    ).toBe(NOW + 1);
  });

  it('should warn right after the election opens (block time vs this clock)', () => {
    const check = canApply({ phase: 'no-election', opensAtMs: NOW - 60_000 }, NOW);
    expect(check.ok && check.warning).toMatch(/40135/);
    expect(canApply({ phase: 'no-election', opensAtMs: NOW - LATE_APPLY_MARGIN_MS - 1 }, NOW)).toEqual({ ok: true });
  });
});

describe('charter validation', () => {
  it('should accept three capital letters and refuse anything else', () => {
    expect(validateReason({ code: 'SPM', label: 'Spam' })).toEqual([]);
    for (const code of ['spm', 'SP', 'SPAM', 'S1M', '']) {
      expect(validateReason({ code, label: 'Spam' })).toHaveLength(1);
    }
    expect(validateReason({ code: 'SPM', label: 'Spam' }, ['SPM'])[0]).toMatch(/reuse/);
    expect(validateReason({ code: 'SPM', label: '' })[0]).toMatch(/label/);
    expect(validateReason({ code: 'SPM', label: 'x'.repeat(65) })[0]).toMatch(/64/);
    expect(validateReason({ code: 'SPM', label: 'x', description: 'd'.repeat(1025) })[0]).toMatch(/1024/);
  });

  it('should require the reward split to sum to 100 in whole percents', () => {
    expect(validateRewardSplit({ leader: 40, equal: 30, actions: 30 })).toEqual([]);
    expect(validateRewardSplit({ leader: 100, equal: 0, actions: 0 })).toEqual([]);
    expect(validateRewardSplit({ leader: 40, equal: 30, actions: 31 })[0]).toMatch(/101.*10422/);
    expect(validateRewardSplit({ leader: 40.5, equal: 29.5, actions: 30 })[0]).toMatch(/whole/);
    expect(validateRewardSplit({ leader: -10, equal: 60, actions: 50 })[0]).toMatch(/whole/);
    expect(validateRewardSplit({ leader: Number.NaN, equal: 50, actions: 50 })).toHaveLength(1);
  });

  it('should check the charter fields against the schema', () => {
    const ok = { description: 'We moderate.', reasonIds: [id32(1)], rewardSplit: { leader: 40, equal: 30, actions: 30 } };
    expect(validateCharter(ok)).toEqual([]);
    expect(validateCharter({ ...ok, moderatorsShare: 0 })).toEqual([]);
    expect(validateCharter({ ...ok, moderatorsShare: 101 })[0]).toMatch(/share/);
    expect(validateCharter({ ...ok, moderatorsShare: 50.5 })[0]).toMatch(/share/);
    expect(validateCharter({ ...ok, description: '  ' })[0]).toMatch(/Describe/);
    expect(validateCharter({ ...ok, description: 'é'.repeat(2049) })[0]).toMatch(/4098 bytes/);
    expect(validateCharter({ ...ok, reasonIds: [id32(1), id32(1)] })[0]).toMatch(/twice/);
    expect(validateCharter({ ...ok, reasonIds: Array.from({ length: 65 }, (_, i) => id32(i)) })[0]).toMatch(/64/);
    expect(validateCharter({ ...ok, reasonIds: [] })).toEqual([]);
  });

  it('should cap members at 15 joiners, never the leader', () => {
    const joiners = new Set(Array.from({ length: 20 }, (_, i) => id32(i + 1)));
    const fifteen = [...joiners].slice(0, MAX_ELECTED_MEMBERS);
    expect(validateMembers({ leaderId: LEADER, members: fifteen, joiners })).toEqual([]);
    expect(validateMembers({ leaderId: LEADER, members: [...joiners].slice(0, 16), joiners })[0]).toMatch(/15/);
    expect(validateMembers({ leaderId: LEADER, members: [LEADER], joiners: new Set([LEADER]) })[0]).toMatch(/leader/);
    expect(validateMembers({ leaderId: LEADER, members: [MEMBER], joiners })[0]).toMatch(/40120/);
    expect(validateMembers({ leaderId: LEADER, members: [id32(1), id32(1)], joiners })[0]).toMatch(/twice/);
    expect(validateMembers({ leaderId: LEADER, members: [], joiners })).toEqual([]);
  });

  it('should note where the equal share goes with no members', () => {
    expect(splitNotes({ leader: 40, equal: 30, actions: 30 }, 0)[0]).toMatch(/30% equal share/);
    expect(splitNotes({ leader: 40, equal: 30, actions: 30 }, 2)).toEqual([]);
    expect(splitNotes({ leader: 100, equal: 0, actions: 0 }, 0)).toEqual([]);
    expect(splitNotes(undefined, 0)).toEqual([]);
  });

  it('should bound the join message to 1023 bytes', () => {
    expect(validateJoinMessage('hello')).toEqual([]);
    expect(validateJoinMessage('')).toHaveLength(1);
    expect(validateJoinMessage('x'.repeat(1024))[0]).toMatch(/1023/);
  });
});

describe('moderated-contract directory', () => {
  it('should merge known, contested and added ids once each, keeping every source', () => {
    expect(mergeDirectory([TARGET], [TARGET, MEMBER], [MEMBER, LEADER])).toEqual([
      { id: TARGET, sources: ['known', 'contested'] },
      { id: MEMBER, sources: ['contested', 'added'] },
      { id: LEADER, sources: ['added'] },
    ]);
  });
});

describe('reasons just filed', () => {
  const reason = (id: string, code: string) => ({ id, ownerId: LEADER, code, label: code });

  it('should list a filed reason the read does not have yet, in code order', () => {
    const merged = mergeReasons([reason('a', 'ABU'), reason('c', 'SPM')], [reason('b', 'OFF')]);
    expect(merged.map((r) => r.code)).toEqual(['ABU', 'OFF', 'SPM']);
  });

  it('should keep the read copy once the read has the filed reason', () => {
    const read = [{ ...reason('b', 'OFF'), description: 'from Platform' }];
    expect(mergeReasons(read, [reason('b', 'OFF')])).toEqual(read);
  });
});

describe('charter kind', () => {
  it('should title a contest by its target, falling back to the short id', () => {
    const key = charterPollKey(TARGET);
    expect(targetName(TARGET)).toBe(`${TARGET.slice(0, 6)}…${TARGET.slice(-6)}`);
    expect(charterTitle({ key, keyString: encodePollKey(key) })).toBe(`Moderators of ${targetName(TARGET)}`);
  });

  const proposal = (over: Partial<CharterProposal> = {}): CharterProposal => ({
    id: id32(1),
    leaderId: LEADER,
    targetContractId: TARGET,
    description: 'We keep threads on topic.',
    reasonIds: [],
    moderatorsShare: 60,
    rewardSplit: { leader: 40, equal: 30, actions: 30 },
    createdAtMs: 1_790_000_000_000,
    ...over,
  });

  it('should describe a contender from its application and proposal', () => {
    const view = charterApplicationView({
      target: TARGET,
      proposal: proposal(),
      reasons: [{ code: 'OFF', label: 'Off-topic' }],
      application: {
        id: id32(4),
        leaderId: LEADER,
        targetContractId: TARGET,
        submittedCharterId: id32(1),
        members: [MEMBER],
        createdAtMs: 1_790_000_000_000,
      },
      memberNames: ['alice'],
    });
    expect(view).toMatchObject({
      description: 'We keep threads on topic.',
      moderatorsShare: 60,
      rewardSplit: { leader: 40, equal: 30, actions: 30 },
      reasons: [{ code: 'OFF', label: 'Off-topic' }],
      members: ['alice'],
      appliedAtMs: 1_790_000_000_000,
      href: proposalHref(TARGET, id32(1)),
    });
  });

  it('should say a losing application keeps no member list', () => {
    const view = charterApplicationView({ target: TARGET, proposal: proposal() });
    expect(view.members).toBeUndefined();
    expect(view.reasons).toBeUndefined();
    expect(view.href).toBe(proposalHref(TARGET, id32(1)));
  });

  it("should pick the leader's latest proposal for the target, filed before the decision", () => {
    const other = proposal({ id: id32(2), targetContractId: MEMBER, createdAtMs: 1_790_000_009_000 });
    const early = proposal({ id: id32(3), createdAtMs: 1_790_000_001_000 });
    const late = proposal({ id: id32(5), createdAtMs: 1_790_000_005_000 });
    const after = proposal({ id: id32(6), createdAtMs: 1_790_000_020_000 });
    const undated = proposal({ id: id32(7), createdAtMs: undefined });
    const decided = 1_790_000_010_000;
    expect(pickLeaderProposal([early, other, late, after, undated], TARGET, decided)).toEqual({ proposal: late, candidates: 2 });
    expect(pickLeaderProposal([late], TARGET, decided)).toEqual({ proposal: late, candidates: 1 });
    expect(pickLeaderProposal([other, after], TARGET, decided)).toEqual({ proposal: undefined, candidates: 0 });
  });

  it('should say when a losing charter is the latest of several', () => {
    expect(charterApplicationView({ target: TARGET, proposal: proposal(), candidates: 3 }).guessedFrom).toBe(3);
    expect(charterApplicationView({ target: TARGET, proposal: proposal(), candidates: 1 }).guessedFrom).toBeUndefined();
  });
});
