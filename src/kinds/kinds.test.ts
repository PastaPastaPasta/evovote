import { describe, expect, it } from 'vitest';
import { contestedIndices } from '../discovery/contracts';
import { toContest } from '../discovery/voteState';
import { phaseOf } from '../model/contest';
import { encodePollKey, type PollKey } from '../model/pollKey';
import { DPNS_FIXTURES, decodeFixtureDocument } from './__fixtures__/dpnsVoteStates';
import { CHARTERS_CONTRACT_ID, charterKind, charterPollKey } from './charter';
import { DPNS_CONTRACT_ID, dpnsDisplayLabel, dpnsKind, dpnsLabel, dpnsPollKey, normalizeDpnsLabel } from './dpns';
import { genericKind } from './generic';
import { kindFor } from './registry';

const summary = (key: PollKey, endsAtMs?: number) => ({ key, keyString: encodePollKey(key), endsAtMs });

describe('dpns adapter on recorded testnet fixtures', () => {
  it('should map an awarded contest', () => {
    const c = toContest(summary(dpnsPollKey('0range')), DPNS_FIXTURES['0range'], { resolution: 0 });
    expect(c.tally).toEqual({
      contenders: [{ identityId: 'HEAmUtC72dPcZ59yyLUgfS8pfrEWqzYfDPzTofgWxXRr', votes: 8, document: undefined }],
      abstain: 0,
      lock: 0,
      total: 8,
    });
    expect(c.winner).toEqual({
      kind: 'identity',
      identityId: 'HEAmUtC72dPcZ59yyLUgfS8pfrEWqzYfDPzTofgWxXRr',
      rawKind: 'WonByIdentity',
      decidedAtMs: 1763135862066,
    });
    expect(phaseOf(c)).toBe('decided');
    expect(dpnsKind.title(c)).toBe('0range.dash');
  });

  it('should map a locked contest', () => {
    const c = toContest(summary(dpnsPollKey('10stest')), DPNS_FIXTURES['10stest']);
    expect(c.winner).toMatchObject({ kind: 'locked', rawKind: 'Locked', identityId: undefined });
    expect(c.tally.lock).toBe(1);
    expect(c.tally.total).toBe(1);
  });

  it('should count abstentions in the total', () => {
    const c = toContest(summary(dpnsPollKey('001')), DPNS_FIXTURES['001']);
    expect(c.tally.abstain).toBe(4);
    expect(c.tally.total).toBe(4);
  });

  it('should sort contenders by votes and show the requested spelling', () => {
    const key = dpnsPollKey('ther0adn0ttaken');
    const c = toContest(summary(key, Date.now() + 60_000), DPNS_FIXTURES.active, {
      resolution: 0,
      decodeDocument: decodeFixtureDocument,
    });
    expect(c.tally.contenders.map((x) => x.votes)).toEqual([5, 2]);
    expect(c.tally.total).toBe(11);
    expect(dpnsDisplayLabel(c)).toBe('TheRoadNotTaken');
    expect(dpnsKind.title(c)).toBe('TheRoadNotTaken.dash');
    expect(phaseOf(c)).toBe('open');
  });

  it('should keep contenders whose document does not decode', () => {
    const c = toContest(summary(dpnsPollKey('x')), DPNS_FIXTURES.active, {
      decodeDocument: () => {
        throw new Error('bad doc');
      },
    });
    expect(c.tally.contenders).toHaveLength(2);
    expect(c.tally.contenders[0].document).toBeUndefined();
  });

  it('should offer contender, abstain and lock', () => {
    const c = toContest(summary(dpnsPollKey('0range')), DPNS_FIXTURES['0range']);
    expect(dpnsKind.choices(c)).toEqual(['identity', 'abstain', 'lock']);
  });

  it('should recognise only exact DPNS keys', () => {
    expect(dpnsLabel(dpnsPollKey('alice'))).toBe('alice');
    expect(dpnsKind.matches(dpnsPollKey('alice'))).toBe(true);
    const wrongParent: PollKey = { ...dpnsPollKey('alice'), indexValues: [{ type: 'text', value: 'evil' }, { type: 'text', value: 'alice' }] };
    expect(dpnsKind.matches(wrongParent)).toBe(false);
    expect(normalizeDpnsLabel('TheRoadNotTaken')).toBe('ther0adn0ttaken');
    expect(normalizeDpnsLabel('Alice-l')).toBe('a11ce-1');
  });
});

describe('registry', () => {
  it('should pick dpns, charter, then generic', () => {
    expect(kindFor(dpnsPollKey('alice')).id).toBe('dpns');
    expect(kindFor(charterPollKey(DPNS_CONTRACT_ID)).id).toBe('charter');
    const other: PollKey = {
      contractId: '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF',
      documentTypeName: 'card',
      indexName: 'byName',
      indexValues: [{ type: 'text', value: 'ace' }],
    };
    expect(kindFor(other).id).toBe('generic');
  });

  it('should not treat a Text-typed charter key as a charter poll', () => {
    const textKey: PollKey = { ...charterPollKey(DPNS_CONTRACT_ID), indexValues: [{ type: 'text', value: DPNS_CONTRACT_ID }] };
    expect(kindFor(textKey).id).toBe('generic');
  });
});

describe('charter and generic stubs', () => {
  it('should withhold Lock for charters (resolution 1)', () => {
    const c = toContest(summary(charterPollKey(DPNS_CONTRACT_ID)), { contenders: [] }, { resolution: 1 });
    expect(charterKind.choices(c)).toEqual(['identity', 'abstain']);
    expect(charterKind.title(c)).toMatch(/^Moderators of contract GWRSAV…/);
  });

  it('should take the generic resolution from the contract, withholding Lock when unknown', () => {
    const key: PollKey = { contractId: CHARTERS_CONTRACT_ID, documentTypeName: 't', indexName: 'i', indexValues: [{ type: 'integer', value: 7n }] };
    const base = toContest(summary(key), { contenders: [] });
    expect(genericKind.choices({ ...base, resolution: 0 })).toContain('lock');
    expect(genericKind.choices({ ...base, resolution: 1 })).not.toContain('lock');
    expect(genericKind.choices(base)).not.toContain('lock');
    expect(genericKind.title(base)).toBe('t · 7 · EG7RGf…4UmN88');
  });
});

describe('contestedIndices', () => {
  // Shapes recorded from rc.4 `contract.toJSON()` on testnet.
  it('should read resolution 0 for DPNS and 1 for elected charters', () => {
    const dpns = {
      documentSchemas: {
        domain: {
          indices: [
            { name: 'parentNameAndLabel', properties: [{ normalizedParentDomainName: 'asc' }, { normalizedLabel: 'asc' }], contested: { resolution: 0, fieldMatches: [] } },
            { name: 'identityId', properties: [{ records: 'asc' }] },
          ],
        },
      },
    };
    expect(contestedIndices(dpns)).toEqual([
      {
        documentTypeName: 'domain',
        indexName: 'parentNameAndLabel',
        properties: ['normalizedParentDomainName', 'normalizedLabel'],
        resolution: 0,
        fieldMatches: [],
        description: undefined,
      },
    ]);
    const charters = {
      documentSchemas: {
        electedCharter: {
          indices: [{ name: 'byTargetContract', properties: [{ targetContractId: 'asc' }], contested: { resolution: 1, description: 'Contest for the moderation seat' } }],
        },
      },
    };
    expect(contestedIndices(charters)[0]).toMatchObject({ indexName: 'byTargetContract', resolution: 1 });
    expect(contestedIndices(null)).toEqual([]);
  });
});
