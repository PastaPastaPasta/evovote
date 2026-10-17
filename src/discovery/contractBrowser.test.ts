import type { EvoSDK } from '@dashevo/evo-sdk';
import { describe, expect, it } from 'vitest';
import { base58Encode } from '../model/bytes';
import type { Contest, ContestSummary } from '../model/contest';
import { encodePollKey } from '../model/pollKey';
import {
  browseContract,
  indexValueForProperty,
  sweepContestedIndex,
  type ContractView,
} from './contractBrowser';
import type { ContestedIndex } from './contracts';
import { toContest } from './voteState';

const OWNER = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 9));

const schema = {
  properties: {
    group: { type: 'string' },
    rank: { type: 'integer' },
    owner: { type: 'array', byteArray: true, contentMediaType: 'application/x.dash.dpp.identifier' },
    nested: { type: 'object', properties: { ref: { type: 'array', byteArray: true, contentMediaType: 'application/x.dash.dpp.identifier' } } },
  },
};

const index = (properties: string[], resolution: 0 | 1 = 0): ContestedIndex => ({
  documentTypeName: 'card',
  indexName: 'byProps',
  properties,
  resolution,
  fieldMatches: [],
});

/**
 * A fake `group.contestedResources` over a tree: the key is the prefix
 * joined with '/', the value the sorted list of next values.
 */
function fakeGroup(tree: Record<string, unknown[]>, opts: { failAt?: string } = {}) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    group: {
      async contestedResources(q: Record<string, unknown>) {
        calls.push(q);
        const prefix = ((q.startIndexValues as unknown[]) ?? []).join('/');
        if (opts.failAt === prefix) throw { message: 'node unavailable', code: -1 };
        const all = tree[prefix] ?? [];
        const after = q.startAtValue;
        const start = after === undefined ? 0 : all.indexOf(after) + 1;
        return all.slice(start, start + (q.limit as number));
      },
    },
  };
}

async function collect(gen: AsyncGenerator<{ keys: { indexValues: unknown[] }[]; failure?: unknown; cap?: unknown }>) {
  const keys: unknown[][] = [];
  const failures: unknown[] = [];
  const caps: unknown[] = [];
  for await (const page of gen) {
    keys.push(...page.keys.map((k) => k.indexValues));
    if (page.failure) failures.push(page.failure);
    if (page.cap) caps.push(page.cap);
  }
  return { keys, failures, caps };
}

describe('indexValueForProperty', () => {
  it('should type values by the contract schema', () => {
    expect(indexValueForProperty('x', 'group', schema)).toEqual({ type: 'text', value: 'x' });
    expect(indexValueForProperty(5, 'rank', schema)).toEqual({ type: 'integer', value: 5n });
    expect(indexValueForProperty(5n, 'rank', schema)).toEqual({ type: 'integer', value: 5n });
    expect(indexValueForProperty(1.5, 'rank', schema)).toBeUndefined();
    expect(indexValueForProperty(OWNER, 'owner', schema)).toEqual({ type: 'identifier', value: OWNER });
    expect(indexValueForProperty({ toBase58: () => OWNER }, 'owner', schema)).toEqual({ type: 'identifier', value: OWNER });
    expect(indexValueForProperty(OWNER, 'nested.ref', schema)).toEqual({ type: 'identifier', value: OWNER });
  });

  it('should type system properties without a schema entry', () => {
    expect(indexValueForProperty(OWNER, '$ownerId', schema)).toEqual({ type: 'identifier', value: OWNER });
    expect(indexValueForProperty(1700000000000, '$createdAt', schema)).toEqual({ type: 'integer', value: 1700000000000n });
  });

  it('should fall back to the JS type when the property is unknown', () => {
    expect(indexValueForProperty('s', 'missing', schema)).toEqual({ type: 'text', value: 's' });
    expect(indexValueForProperty(true, 'missing', schema)).toEqual({ type: 'bool', value: true });
  });
});

describe('sweepContestedIndex', () => {
  it('should list a single-property index from the root', async () => {
    const { group, calls } = fakeGroup({ '': ['a', 'b', 'c'] });
    const sdk = { group } as unknown as EvoSDK;
    const { keys } = await collect(sweepContestedIndex(sdk, 'k1', index(['group']), schema));
    expect(keys).toEqual([[{ type: 'text', value: 'a' }], [{ type: 'text', value: 'b' }], [{ type: 'text', value: 'c' }]]);
    expect(calls[0]).toMatchObject({ dataContractId: 'k1', documentTypeName: 'card', indexName: 'byProps' });
    expect(calls[0]).not.toHaveProperty('startIndexValues');
  });

  it('should walk a multi-property index as a tree, using each level as the next prefix', async () => {
    const { group, calls } = fakeGroup({ '': ['dash', 'xyz'], dash: ['000', '001'], xyz: ['q'] });
    const sdk = { group } as unknown as EvoSDK;
    const { keys, failures } = await collect(sweepContestedIndex(sdk, 'k2', index(['group', 'group']), schema));
    expect(failures).toEqual([]);
    expect(keys.map((v) => v.map((x) => (x as { value: string }).value))).toEqual([
      ['dash', '000'],
      ['dash', '001'],
      ['xyz', 'q'],
    ]);
    expect(calls.map((c) => c.startIndexValues)).toEqual([undefined, ['dash'], ['xyz']]);
  });

  it('should pass identifiers as base58 strings and keep their type in the key', async () => {
    const { group, calls } = fakeGroup({ '': [OWNER], [OWNER]: [3] });
    const sdk = { group } as unknown as EvoSDK;
    const { keys } = await collect(sweepContestedIndex(sdk, 'k3', index(['owner', 'rank']), schema));
    expect(keys).toEqual([[{ type: 'identifier', value: OWNER }, { type: 'integer', value: 3n }]]);
    expect(calls[1].startIndexValues).toEqual([OWNER]);
  });

  it('should page, and cap at maxContests once a further value proves there are more', async () => {
    const values = Array.from({ length: 12 }, (_, i) => `v${String(i).padStart(2, '0')}`);
    const sdk = { group: fakeGroup({ '': values }).group } as unknown as EvoSDK;
    const capped = await collect(sweepContestedIndex(sdk, 'k4', index(['group']), schema, { pageSize: 5, maxContests: 7 }));
    expect(capped.keys).toHaveLength(7);
    expect(capped.caps).toEqual([{ source: 'card · byProps', limit: 7 }]);
    // Exactly at the limit is not a cap: nothing more exists.
    const exact = await collect(sweepContestedIndex(sdk, 'k4', index(['group']), schema, { pageSize: 4, maxContests: 12 }));
    expect(exact.keys).toHaveLength(12);
    expect(exact.caps).toEqual([]);
  });

  it('should report a failed branch and keep the other branches', async () => {
    const { group } = fakeGroup({ '': ['a', 'b'], a: ['x'], b: ['y'] }, { failAt: 'a' });
    const sdk = { group } as unknown as EvoSDK;
    const { keys, failures } = await collect(sweepContestedIndex(sdk, 'k5', index(['group', 'group']), schema));
    expect(keys.map((v) => (v[1] as { value: string }).value)).toEqual(['y']);
    expect(failures).toEqual([{ source: 'card · byProps', message: 'node unavailable' }]);
  });

  it('should stop when aborted', async () => {
    const abort = new AbortController();
    const sdk = { group: fakeGroup({ '': ['a', 'b', 'c'] }).group } as unknown as EvoSDK;
    abort.abort();
    const { keys } = await collect(sweepContestedIndex(sdk, 'k6', index(['group']), schema, { signal: abort.signal }));
    expect(keys).toEqual([]);
  });
});

// ---- browseContract ------------------------------------------------------------

const contractJson = {
  documentSchemas: {
    card: {
      ...schema,
      indices: [
        {
          name: 'byProps',
          properties: [{ group: 'asc' }],
          unique: true,
          contested: { resolution: 1, fieldMatches: [{ field: 'group', regexPattern: '^[a-z]+$' }], description: 'Pick one' },
        },
      ],
    },
    plain: { properties: { x: { type: 'string' } }, indices: [{ name: 'byX', properties: [{ x: 'asc' }] }] },
  },
};

function browserSdk(opts: {
  contracts: Record<string, unknown>;
  tree?: Record<string, unknown[]>;
  fetchError?: Error;
}) {
  return {
    version: () => 14,
    contracts: {
      async fetch(id: string) {
        if (opts.fetchError) throw opts.fetchError;
        const json = opts.contracts[id];
        return json === undefined ? null : { toJSON: () => json };
      },
    },
    group: fakeGroup(opts.tree ?? {}).group,
  } as unknown as EvoSDK;
}

const stateFor =
  (overrides: Record<string, Partial<Parameters<typeof toContest>[1]> | 'fail'> = {}) =>
  async (_sdk: EvoSDK, summary: ContestSummary): Promise<Contest> => {
    const label = (summary.key.indexValues[0] as { value: string }).value;
    const override = overrides[label];
    if (override === 'fail') throw new Error('state read failed');
    return toContest(summary, { contenders: [{ identityId: OWNER, voteTally: 2 }], ...override }, { resolution: 1 });
  };

const noActive = async () => ({ polls: [], failures: [] });

describe('browseContract', () => {
  it('should say the contract is missing', async () => {
    const view = await browseContract(browserSdk({ contracts: {} }), 'missing-contract', { readActive: noActive });
    expect(view.load).toBe('not-found');
    expect(view.types).toEqual([]);
  });

  it('should carry a failed contract read as a failure, not as "no contested index"', async () => {
    const sdk = browserSdk({ contracts: {}, fetchError: new Error('dapi down') });
    const view = await browseContract(sdk, 'failing-contract', { readActive: noActive });
    expect(view.load).toBe('error');
    expect(view.failures).toEqual([{ source: 'the contract', message: 'dapi down' }]);
  });

  it('should list the document types and report plainly when none is contested', async () => {
    const sdk = browserSdk({ contracts: { 'plain-contract': { documentSchemas: { plain: contractJson.documentSchemas.plain } } } });
    const view = await browseContract(sdk, 'plain-contract', { readActive: noActive });
    expect(view.load).toBe('ready');
    expect(view.documentTypes).toEqual(['plain']);
    expect(view.types).toEqual([]);
  });

  it('should sweep each contested index and read every value with end times and states', async () => {
    const sdk = browserSdk({ contracts: { 'cards-contract': contractJson }, tree: { '': ['alpha', 'beta', 'gamma'] } });
    const alphaKey = {
      contractId: 'cards-contract',
      documentTypeName: 'card',
      indexName: 'byProps',
      indexValues: [{ type: 'text' as const, value: 'alpha' }],
    };
    const updates: ContractView[] = [];
    const view = await browseContract(sdk, 'cards-contract', {
      readActive: async () => ({
        polls: [{ key: alphaKey, keyString: encodePollKey(alphaKey), endsAtMs: 123456 }],
        failures: [{ source: 'active polls', message: 'partial' }],
      }),
      readContest: stateFor({ beta: 'fail' }),
      onUpdate: (v) => updates.push(v),
    });
    expect(view.load).toBe('ready');
    expect(view.documentTypes).toEqual(['card', 'plain']);
    expect(view.types).toHaveLength(1);
    const [type] = view.types;
    expect(type.index).toMatchObject({ indexName: 'byProps', resolution: 1, fieldMatches: [{ field: 'group', regexPattern: '^[a-z]+$' }] });
    expect(type.sweeping).toBe(false);
    expect(type.contests.map((c) => c.summary.endsAtMs)).toEqual([123456, undefined, undefined]);
    expect(type.contests.map((c) => (typeof c.state === 'object' ? c.state.tally.total : c.state))).toEqual([2, 'error', 2]);
    expect(view.failures).toEqual([{ source: 'active polls', message: 'partial' }]);
    // Progressive snapshots: loading first, states filled in as they land.
    expect(updates[0].load).toBe('loading');
    expect(updates.some((u) => u.types[0]?.contests.some((c) => c.state === 'loading'))).toBe(true);
  });

  it('should read states with bounded concurrency', async () => {
    const values = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const sdk = browserSdk({ contracts: { 'many-contract': contractJson }, tree: { '': values } });
    let inFlight = 0;
    let peak = 0;
    const view = await browseContract(sdk, 'many-contract', {
      readActive: noActive,
      tallyConcurrency: 3,
      readContest: async (s, summary) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return stateFor()(s, summary);
      },
    });
    expect(peak).toBe(3);
    expect(view.types[0].contests.every((c) => typeof c.state === 'object')).toBe(true);
  });

  it('should show a cap and a sweep failure, never an empty list', async () => {
    const sdk = browserSdk({ contracts: { 'cap-contract': contractJson, 'fail-contract': contractJson }, tree: { '': ['a', 'b', 'c'] } });
    const capped = await browseContract(sdk, 'cap-contract', { readActive: noActive, readContest: stateFor(), maxContests: 2 });
    expect(capped.types[0].contests).toHaveLength(2);
    expect(capped.caps).toEqual([{ source: 'card · byProps', limit: 2 }]);

    const failing = {
      ...(sdk as unknown as object),
      group: fakeGroup({}, { failAt: '' }).group,
    } as unknown as EvoSDK;
    const failed = await browseContract(failing, 'fail-contract', { readActive: noActive, readContest: stateFor() });
    expect(failed.types[0].contests).toEqual([]);
    expect(failed.failures).toEqual([{ source: 'card · byProps', message: 'node unavailable' }]);
  });

  it('should carry a failed active-poll read as a failure', async () => {
    const sdk = browserSdk({ contracts: { 'active-fail-contract': contractJson }, tree: { '': ['a'] } });
    const view = await browseContract(sdk, 'active-fail-contract', {
      readActive: async () => {
        throw new Error('walk failed');
      },
      readContest: stateFor(),
    });
    expect(view.failures).toEqual([{ source: 'active polls', message: 'walk failed' }]);
    expect(view.types[0].contests).toHaveLength(1);
  });

  it('should stop reading states when aborted', async () => {
    const values = Array.from({ length: 8 }, (_, i) => `v${i}`);
    const sdk = browserSdk({ contracts: { 'abort-contract': contractJson }, tree: { '': values } });
    const abort = new AbortController();
    let reads = 0;
    await browseContract(sdk, 'abort-contract', {
      readActive: noActive,
      tallyConcurrency: 1,
      signal: abort.signal,
      readContest: async (s, summary) => {
        reads++;
        abort.abort();
        return stateFor()(s, summary);
      },
    });
    expect(reads).toBe(1);
  });
});
