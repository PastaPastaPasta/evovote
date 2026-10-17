import type { EvoSDK } from '@dashevo/evo-sdk';
import { describe, expect, it } from 'vitest';
import { readEntries } from '../discovery/activePolls';
import { contestedIndices } from '../discovery/contracts';
import { toContest } from '../discovery/voteState';
import { base58Encode } from '../model/bytes';
import { encodePollKey, type PollKey } from '../model/pollKey';
import { canVoteOnPoll, votePollFor } from '../voting/cast';
import { documentRows, fieldValue } from './fields';
import { describeIndex, fieldMatchWords, genericKind, resolutionWords } from './generic';
import { kindFor } from './registry';

const ID_A = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ID_B = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));

const summary = (key: PollKey) => ({ key, keyString: encodePollKey(key) });
const pollKey = (values: PollKey['indexValues'], contractId = ID_A): PollKey => ({
  contractId,
  documentTypeName: 'proposal',
  indexName: 'byTopic',
  indexValues: values,
});

describe('generic title', () => {
  it('should show the document type, decoded values and the short contract id', () => {
    const c = toContest(
      summary(pollKey([{ type: 'text', value: 'ace' }, { type: 'integer', value: 7n }, { type: 'identifier', value: ID_B }])),
      { contenders: [] },
    );
    expect(genericKind.title(c)).toBe(`proposal · ace / 7 / ${ID_B.slice(0, 6)}…${ID_B.slice(-6)} · ${ID_A.slice(0, 6)}…${ID_A.slice(-6)}`);
  });

  it('should render bytes as hex, bools, null and clip long text', () => {
    const c = toContest(
      summary(
        pollKey([
          { type: 'bytes', value: Uint8Array.from([0xde, 0xad]) },
          { type: 'bool', value: true },
          { type: 'null' },
          { type: 'text', value: 'x'.repeat(100) },
        ]),
      ),
      { contenders: [] },
    );
    const title = genericKind.title(c);
    expect(title).toContain('0xdead / true / null / ');
    expect(title).toContain(`${'x'.repeat(39)}…`);
    expect(title).not.toContain('x'.repeat(41));
  });
});

describe('generic choices', () => {
  const base = toContest(summary(pollKey([{ type: 'text', value: 'a' }])), { contenders: [] });
  it('should follow the index resolution: 0 allows Lock, 1 does not, unknown withholds it', () => {
    expect(genericKind.choices({ ...base, resolution: 0 })).toEqual(['identity', 'abstain', 'lock']);
    expect(genericKind.choices({ ...base, resolution: 1 })).toEqual(['identity', 'abstain']);
    expect(genericKind.choices(base)).toEqual(['identity', 'abstain']);
  });
});

describe('generic contender view', () => {
  const schema = {
    properties: {
      title: { type: 'string' },
      owner: { type: 'array', byteArray: true, contentMediaType: 'application/x.dash.dpp.identifier' },
      blob: { type: 'array', byteArray: true },
    },
  };
  const contractJson = { documentSchemas: { proposal: schema } };
  const sdk = {
    version: () => 14,
    contracts: { fetch: async () => ({ toJSON: () => contractJson }) },
  } as unknown as EvoSDK;

  it('should type the decoded document fields using the contract schema', async () => {
    const key = pollKey([{ type: 'text', value: 'view' }], 'contract-view');
    const contest = toContest(summary(key), { contenders: [] });
    const view = await genericKind.describeContender(sdk, contest, {
      identityId: ID_B,
      votes: 1,
      document: {
        blob: 'AAEC', // base64 of 00 01 02
        title: 'Hello',
        $revision: 1,
        owner: ID_B,
        $ownerId: ID_A,
        $id: ID_B,
        meta: { a: [1, 2], b: null },
      },
    });
    expect(view.identityId).toBe(ID_B);
    expect(view.rows?.map((r) => r.name)).toEqual(['$id', '$ownerId', '$revision', 'blob', 'title', 'owner', 'meta']);
    const byName = Object.fromEntries((view.rows ?? []).map((r) => [r.name, r.value]));
    expect(byName.$id).toEqual({ kind: 'identifier', id: ID_B });
    expect(byName.owner).toEqual({ kind: 'identifier', id: ID_B });
    expect(byName.blob).toEqual({ kind: 'bytes', hex: '000102' });
    expect(byName.$revision).toEqual({ kind: 'text', text: '1' });
    expect(byName.title).toEqual({ kind: 'text', text: 'Hello' });
    expect(byName.meta).toMatchObject({ kind: 'json' });
  });

  it('should show no rows when the vote state carried no document', async () => {
    const contest = toContest(summary(pollKey([{ type: 'text', value: 'nodoc' }])), { contenders: [] });
    await expect(genericKind.describeContender(sdk, contest, { identityId: ID_B, votes: 0 })).resolves.toEqual({
      identityId: ID_B,
    });
  });

  it('should still render rows when the contract cannot be read', async () => {
    const failing = {
      version: () => 14,
      contracts: {
        fetch: async () => {
          throw new Error('offline');
        },
      },
    } as unknown as EvoSDK;
    const contest = toContest(summary(pollKey([{ type: 'text', value: 'x' }], 'contract-offline')), { contenders: [] });
    const view = await genericKind.describeContender(failing, contest, {
      identityId: ID_B,
      votes: 0,
      document: { name: 'n', ref: ID_A },
    });
    // No schema: a 32-byte base58 string is taken as an identifier.
    expect(view.rows).toEqual([
      { name: 'name', value: { kind: 'text', text: 'n' } },
      { name: 'ref', value: { kind: 'identifier', id: ID_A } },
    ]);
  });
});

describe('fieldValue', () => {
  it('should keep lookalike text as text when the schema says string', () => {
    expect(fieldValue('note', ID_A, { type: 'string' })).toEqual({ kind: 'text', text: ID_A });
  });
  it('should treat number arrays under a byteArray schema as bytes or identifiers', () => {
    expect(fieldValue('b', [1, 255], { type: 'array', byteArray: true })).toEqual({ kind: 'bytes', hex: '01ff' });
    const bytes = Array.from({ length: 32 }, (_, i) => i + 1);
    expect(
      fieldValue('o', bytes, { type: 'array', byteArray: true, contentMediaType: 'application/x.dash.dpp.identifier' }),
    ).toEqual({ kind: 'identifier', id: ID_A });
  });
  it('should render bigint, null and nested values', () => {
    expect(fieldValue('n', 12n)).toEqual({ kind: 'text', text: '12' });
    expect(fieldValue('n', null)).toEqual({ kind: 'text', text: 'null' });
    expect(fieldValue('o', { big: 5n })).toEqual({ kind: 'json', text: '{\n  "big": "5"\n}' });
  });
  it('should order system fields first', () => {
    expect(documentRows({ z: 1, $updatedAt: 2, a: 3, $id: ID_A }).map((r) => r.name)).toEqual(['$id', '$updatedAt', 'z', 'a']);
  });
});

describe('index rules in plain words', () => {
  // Recorded from rc.4 `contract.toJSON()` of DPNS on testnet.
  const dpnsJson = {
    documentSchemas: {
      domain: {
        indices: [
          {
            name: 'parentNameAndLabel',
            properties: [{ normalizedParentDomainName: 'asc' }, { normalizedLabel: 'asc' }],
            unique: true,
            contested: {
              fieldMatches: [{ field: 'normalizedLabel', regexPattern: '^[a-zA-Z01-]{3,19}$' }],
              resolution: 0,
              description: 'A vote takes place for short names',
            },
          },
        ],
      },
    },
  };

  it('should read fieldMatches from the contract', () => {
    expect(contestedIndices(dpnsJson)[0].fieldMatches).toEqual([
      { field: 'normalizedLabel', regexPattern: '^[a-zA-Z01-]{3,19}$' },
    ]);
  });

  it('should explain resolution 0 and 1', () => {
    expect(resolutionWords(0)).toMatch(/lock the resource/);
    expect(resolutionWords(1)).toMatch(/Lock is not allowed.*earliest contender/);
    expect(resolutionWords(undefined)).toMatch(/could not be read/);
  });

  it('should explain field matches, and their absence', () => {
    expect(fieldMatchWords([])).toEqual(['No field filter: every new document on this index enters a masternode vote.']);
    expect(fieldMatchWords([{ field: 'label', regexPattern: '^a$' }])).toEqual([
      'A vote opens only if “label” matches ^a$.',
      'Documents that do not match are created normally, with no vote.',
    ]);
    const lines = describeIndex(contestedIndices(dpnsJson)[0]);
    expect(lines[0]).toBe('A vote takes place for short names');
    expect(lines).toHaveLength(4);
  });
});

describe('non-DPNS, non-charter polls found by discovery', () => {
  // A poll on another contract whose first value is an Identifier on chain
  // (bincode tag 16 + 32 bytes) and second an integer (U64 tag 2, varint).
  const identifierBytes = Uint8Array.from([16, ...Array.from({ length: 32 }, (_, i) => i + 1)]);
  const chainPoll = {
    contractId: { toBase58: () => ID_B },
    documentTypeName: 'proposal',
    indexName: 'byTopic',
    indexValues: [identifierBytes, Uint8Array.from([2, 7])],
  };

  it('should render through the generic kind and be votable via the live poll', () => {
    const read = readEntries([{ timestampMs: 5_000n, votePolls: [chainPoll] }]);
    expect(read.unreadable).toBe(0);
    const [found] = read.summaries;
    expect(found.key.indexValues).toEqual([
      { type: 'identifier', value: ID_A },
      { type: 'integer', value: 7n },
    ]);
    expect(kindFor(found.key).id).toBe('generic');
    // The poll cannot be rebuilt with new VotePoll(), but the walk kept the chain's object.
    expect(canVoteOnPoll(found.key, found.keyString)).toBe(true);
    const { poll, owned } = votePollFor({} as never, found.key, found.keyString);
    expect(owned).toBe(false);
    expect(poll).toBe(chainPoll);
  });

  it('should refuse a non-constructible poll that no walk has seen', () => {
    const key = pollKey([{ type: 'identifier', value: ID_A }], 'never-seen');
    const keyString = encodePollKey(key);
    expect(canVoteOnPoll(key, keyString)).toBe(false);
    expect(() => votePollFor({} as never, key, keyString)).toThrow(/not in the current list of open polls/);
  });

  it('should allow a text-only poll to be rebuilt without a live object', () => {
    const key = pollKey([{ type: 'text', value: 'plain' }], 'text-only');
    expect(canVoteOnPoll(key, encodePollKey(key))).toBe(true);
  });
});
