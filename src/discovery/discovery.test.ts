import type { EvoSDK } from '@dashevo/evo-sdk';
import { describe, expect, it } from 'vitest';
import { choiceFromJson, readResourceVote } from '../voting/currentVotes';
import { fetchActivePolls, readEntries, type EndDateEntryLike } from './activePolls';
import { sweepContestedResources } from './archive';
import { createPump, forEachConcurrent } from './concurrency';

const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const textBytes = (s: string) => {
  const utf8 = new TextEncoder().encode(s);
  return Uint8Array.from([0x12, utf8.length, ...utf8]);
};
const poll = (label: string) => ({
  contractId: { toBase58: () => DPNS },
  documentTypeName: 'domain',
  indexName: 'parentNameAndLabel',
  indexValues: [textBytes('dash'), textBytes(label)],
});
const entry = (ts: number, labels: string[]): EndDateEntryLike => ({
  timestampMs: BigInt(ts),
  votePolls: labels.map(poll),
});

describe('readEntries', () => {
  it('should map entries to summaries with end times and count polls', () => {
    const read = readEntries([entry(1000, ['a', 'b']), entry(2000, ['c'])], () => {});
    expect(read.summaries.map((s) => [s.key.indexValues[1], s.endsAtMs])).toEqual([
      [{ type: 'text', value: 'a' }, 1000],
      [{ type: 'text', value: 'b' }, 1000],
      [{ type: 'text', value: 'c' }, 2000],
    ]);
    expect(read).toMatchObject({ pollCount: 3, unreadable: 0, first: 1000n, last: 2000n });
  });

  it('should count unreadable polls instead of dropping them silently', () => {
    const read = readEntries([{ timestampMs: 5n, votePolls: [null, poll('a')] }], () => {});
    expect(read.summaries).toHaveLength(1);
    expect(read.unreadable).toBe(1);
  });
});

/** A fake SDK whose votePollsByEndDate pages a fixed list ascending by time. */
function fakeSdk(all: EndDateEntryLike[], opts: { failBounded?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const sdk = {
    voting: {
      async votePollsByEndDate(q: Record<string, unknown>) {
        calls.push(q);
        if (opts.failBounded && q.endTimeMs !== undefined) throw { message: 'bounds refused', code: -1 };
        const start = q.startTimeMs as bigint | undefined;
        const included = q.startTimeIncluded !== false;
        const end = q.endTimeMs as number | undefined;
        const limit = q.limit as number;
        const out: EndDateEntryLike[] = [];
        let polls = 0;
        for (const e of all) {
          const ts = BigInt(e.timestampMs);
          if (start !== undefined && (included ? ts < start : ts <= start)) continue;
          if (end !== undefined && ts > BigInt(end)) continue;
          const take = e.votePolls.slice(0, limit - polls);
          out.push({ timestampMs: ts, votePolls: take });
          polls += take.length;
          if (polls >= limit) break;
        }
        return out;
      },
    },
  };
  return { sdk: sdk as unknown as EvoSDK, calls };
}

describe('fetchActivePolls', () => {
  const now = 10_000;

  it('should page forward by timestamp and dedupe re-read buckets', async () => {
    const all = [entry(now + 1, ['a', 'b']), entry(now + 2, ['c', 'd']), entry(now + 3, ['e'])];
    const { sdk, calls } = fakeSdk(all);
    const result = await fetchActivePolls(sdk, { now, pageSize: 3 });
    expect(result.polls.map((p) => (p.key.indexValues[1] as { value: string }).value)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.failures).toEqual([]);
    expect(calls[0]).toMatchObject({ orderAscending: true, limit: 3, endTimeIncluded: true });
    expect(calls[0].endTimeMs).toBeGreaterThan(now);
    // The second page re-reads the cut-short timestamp, inclusively.
    expect(calls[1]).toMatchObject({ startTimeMs: BigInt(now + 2), startTimeIncluded: true });
  });

  it('should report polls it cannot reach past a full single-timestamp page', async () => {
    const { sdk } = fakeSdk([entry(now + 1, ['a', 'b', 'c']), entry(now + 2, ['d'])]);
    const result = await fetchActivePolls(sdk, { now, pageSize: 2 });
    expect(result.polls.map((p) => (p.key.indexValues[1] as { value: string }).value)).toEqual(['a', 'b', 'd']);
    expect(result.failures[0].message).toMatch(/more than 2 polls end at/);
  });

  it('should report a cap instead of truncating silently', async () => {
    const all = Array.from({ length: 10 }, (_, i) => entry(now + i + 1, [`n${i}`]));
    const { sdk } = fakeSdk(all);
    const result = await fetchActivePolls(sdk, { now, pageSize: 2, maxPages: 2 });
    expect(result.caps).toEqual([{ source: 'active polls', limit: result.polls.length }]);
  });

  it('should retry without the upper bound when the bounded query fails, and say so', async () => {
    const { sdk, calls } = fakeSdk([entry(now + 1, ['a'])], { failBounded: true });
    const result = await fetchActivePolls(sdk, { now, pageSize: 5 });
    expect(result.polls).toHaveLength(1);
    expect(result.failures[0].message).toMatch(/without an upper bound/);
    expect(calls.at(-1)?.endTimeMs).toBeUndefined();
  });

  it('should surface a total failure as a failure, not as "no polls"', async () => {
    const sdk = {
      voting: {
        votePollsByEndDate: async () => {
          throw { message: 'down' };
        },
      },
    } as unknown as EvoSDK;
    const result = await fetchActivePolls(sdk, { now });
    expect(result.polls).toEqual([]);
    expect(result.failures).toEqual([{ source: 'active polls', message: 'down' }]);
  });
});

describe('sweepContestedResources', () => {
  it('should page with startAtValue and report caps and failures', async () => {
    const labels = ['a', 'b', 'c', 'd', 'e'];
    const queries: Record<string, unknown>[] = [];
    const sdk = {
      group: {
        async contestedResources(q: Record<string, unknown>) {
          queries.push(q);
          const from = q.startAtValue === undefined ? 0 : labels.indexOf(q.startAtValue as string) + 1;
          return labels.slice(from, from + (q.limit as number));
        },
      },
    } as unknown as EvoSDK;
    const sweep = {
      source: 'test archive',
      contractId: DPNS,
      documentTypeName: 'domain',
      indexName: 'parentNameAndLabel',
      prefix: [{ type: 'text' as const, value: 'dash' }],
      toKey: (r: unknown) => ({ contractId: DPNS, documentTypeName: 'domain', indexName: 'parentNameAndLabel', indexValues: [{ type: 'text' as const, value: r as string }] }),
    };
    const pages = [];
    for await (const page of sweepContestedResources(sdk, sweep, { pageSize: 2, maxPages: 2 })) pages.push(page);
    expect(pages.map((p) => p.keys.length)).toEqual([2, 2, 0]);
    expect(pages[2].cap).toEqual({ source: 'test archive', limit: 4 });
    expect(queries[0]).toMatchObject({ startIndexValues: ['dash'] });
    expect(queries[1]).toMatchObject({ startAtValue: 'b', startAtValueIncluded: false });

    const failing = { group: { contestedResources: async () => { throw { message: 'nope' }; } } } as unknown as EvoSDK;
    const failed = [];
    for await (const page of sweepContestedResources(failing, sweep)) failed.push(page);
    expect(failed).toEqual([{ keys: [], failure: { source: 'test archive', message: 'nope' } }]);
  });
});

describe('concurrency helpers', () => {
  it('should never exceed the limit', async () => {
    let active = 0;
    let peak = 0;
    await forEachConcurrent([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(2);
  });

  it('should drop queued work on cancel', async () => {
    const done: number[] = [];
    const pump = createPump<number>(1, async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
    });
    pump.push([1, 2, 3]);
    pump.cancel();
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toEqual([1]);
  });
});

describe('current votes', () => {
  it('should map ResourceVoteChoice JSON', () => {
    expect(choiceFromJson({ $type: 'towardsIdentity', identity: 'abc' })).toEqual({ type: 'identity', identityId: 'abc' });
    expect(choiceFromJson({ $type: 'abstain' })).toEqual({ type: 'abstain' });
    expect(choiceFromJson({ $type: 'lock' })).toEqual({ type: 'lock' });
    expect(choiceFromJson({ $type: 'other' })).toBeUndefined();
  });

  it('should key a ResourceVote by its poll key', () => {
    let freed = false;
    const read = readResourceVote({
      poll: poll('alice'),
      choice: { toJSON: () => ({ $type: 'abstain' }) },
      free: () => {
        freed = true;
      },
    });
    expect(read?.choice).toEqual({ type: 'abstain' });
    expect(read?.keyString.startsWith(`${DPNS}/domain/parentNameAndLabel/`)).toBe(true);
    expect(freed).toBe(true);
  });
});
