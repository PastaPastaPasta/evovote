import type { EvoSDK } from '@dashevo/evo-sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mergeSweeps, sweepContestedResources, type ArchivePage } from '../../discovery/archive';
import { createWantQueue } from '../../discovery/concurrency';
import { cachedContest, isStorable, loadCachedDirectory, resultOf } from '../../discovery/resultCache';
import { combineReports } from '../../discovery/stream';
import { charterPollKey } from '../../kinds/charter';
import {
  archiveSlices,
  DPNS_VOTE_PERIOD_MS,
  dpnsPollKey,
  dpnsSpelling,
  fetchDpnsNames,
  rememberDpnsSpelling,
  toDpnsName,
} from '../../kinds/dpns';
import { kindFor, sourcesFor } from '../../kinds/registry';
import type { Contest, ContestSummary } from '../../model/contest';
import { encodePollKey, type PollKey } from '../../model/pollKey';
import { BallotBar } from '../components/BallotBar';
import {
  matchesNeedle,
  orderEnded,
  outcomeOf,
  rowLabel,
  toNeedle,
  type DirectoryFacts,
} from './directoryModel';

const summary = (key: PollKey, endsAtMs?: number): ContestSummary => ({ key, keyString: encodePollKey(key), endsAtMs });

function contest(
  key: PollKey,
  votes: number[],
  winner?: { id?: string; locked?: boolean; at?: number },
  extra: { abstain?: number; lock?: number } = {},
): Contest {
  const contenders = votes.map((v, i) => ({ identityId: `id${i}`, votes: v }));
  const abstain = extra.abstain ?? 0;
  const lock = extra.lock ?? 0;
  return {
    ...summary(key),
    tally: { contenders, abstain, lock, total: votes.reduce((a, b) => a + b, 0) + abstain + lock },
    winner: winner
      ? {
          kind: winner.locked ? 'locked' : 'identity',
          identityId: winner.locked ? undefined : (winner.id ?? 'id0'),
          rawKind: winner.locked ? 'Locked' : 'WonByIdentity',
          decidedAtMs: winner.at,
        }
      : undefined,
    unreadableContenders: 0,
  };
}

const facts = (patch: Partial<DirectoryFacts> = {}): DirectoryFacts => ({
  states: {},
  names: {},
  identityNames: {},
  dpnsVotePeriodMs: DPNS_VOTE_PERIOD_MS.testnet,
  ...patch,
});

const TARGET = 'EFyPZPsEDLHtN1R38CgzeAGfWr23DrgthPpTgbCW8zAt';

describe('directory search', () => {
  it('should normalize what is typed like a username', () => {
    expect(toNeedle('  Bob.dash ')).toEqual({ raw: 'Bob.dash', lower: 'bob', normalized: 'b0b' });
    expect(toNeedle('   ')).toBeUndefined();
  });

  it('should find a username by its look-alike spelling, owner and winner', () => {
    const key = dpnsPollKey('b0b');
    const c = summary(key);
    const kind = kindFor(key);
    const f = facts({
      names: { b0b: { label: 'Bob', ownerId: 'OwnerIdentity1111' } },
      states: { [c.keyString]: contest(key, [3, 1], { id: 'id0' }) },
      identityNames: { id1: ['carol.dash'] },
    });
    expect(matchesNeedle(c, kind, f, toNeedle('bob')!)).toBe(true);
    expect(matchesNeedle(c, kind, f, toNeedle('BOB.dash')!)).toBe(true);
    expect(matchesNeedle(c, kind, f, toNeedle('OwnerIdentity1111')!)).toBe(true);
    expect(matchesNeedle(c, kind, f, toNeedle('OwnerI')!)).toBe(true);
    expect(matchesNeedle(c, kind, f, toNeedle('carol')!)).toBe(true);
    expect(matchesNeedle(c, kind, f, toNeedle('alice')!)).toBe(false);
    // "dash" is no longer every row: only the ".dash" suffix is stripped.
    expect(matchesNeedle(c, kind, f, toNeedle('dash')!)).toBe(false);
  });

  it('should find a moderator election by the full target contract id', () => {
    const c = summary(charterPollKey(TARGET));
    expect(matchesNeedle(c, kindFor(c.key), facts(), toNeedle(TARGET)!)).toBe(true);
  });
});

describe('directory order', () => {
  const title = (c: ContestSummary) => (c.key.indexValues[1] as { value: string }).value;

  it('should put awaiting results first, then newest decided, unknown dates last', () => {
    const now = 1_000_000;
    const awaiting = summary(dpnsPollKey('zzz'), now - 1);
    const old = summary(dpnsPollKey('aaa'));
    const fresh = summary(dpnsPollKey('bbb'));
    const unknown = summary(dpnsPollKey('ccc'));
    const locked = summary(dpnsPollKey('ddd'));
    const f = facts({
      names: { aaa: { label: 'aaa', createdAtMs: 100 }, bbb: { label: 'bbb', createdAtMs: 500 } },
      states: { [locked.keyString]: contest(locked.key, [1], { locked: true, at: 300 + DPNS_VOTE_PERIOD_MS.testnet }) },
    });
    const order = orderEnded([unknown, old, locked, fresh, awaiting], f, 'recent', title, now);
    expect(order).toEqual([awaiting, fresh, locked, old, unknown]);
    expect(orderEnded([fresh, old], f, 'name', title, now)).toEqual([old, fresh]);
  });
});

describe('directory outcomes', () => {
  const key = dpnsPollKey('alice');

  it('should say only contender, a score, or locked', () => {
    expect(outcomeOf(contest(key, [0], { at: 5 }))).toMatchObject({ kind: 'awarded', unopposed: true, score: undefined, decidedAtMs: 5 });
    expect(outcomeOf(contest(key, [12, 4], {}))).toMatchObject({ kind: 'awarded', score: '12–4', unopposed: false });
    expect(outcomeOf(contest(key, [3], { locked: true }, { lock: 9 }))).toMatchObject({ kind: 'locked', score: '9–3' });
    // Two contenders and nobody voted: no "0–0".
    expect(outcomeOf(contest(key, [0, 0], {})).score).toBeUndefined();
    expect(outcomeOf(contest(key, [1, 0])).kind).toBe('awaiting');
  });

  it('should label a row for screen readers', () => {
    const c = contest(key, [0], { at: Date.UTC(2025, 2, 7, 12) });
    expect(rowLabel({ title: 'alice.dash', open: false, state: c, winnerName: 'alice' })).toMatch(
      /^alice\.dash — decided .*2025, awarded to alice, only contender, 0 votes$/,
    );
    expect(rowLabel({ title: 'bob.dash', open: true, closes: '2h 5m', state: contest(key, [3]) })).toBe(
      'bob.dash — open, closes in 2h 5m, 3 votes',
    );
  });

  it('should never say "no votes yet" inside a mini bar, nor on an ended contest', () => {
    const empty = { contenders: [], abstain: 0, lock: 0, total: 0 };
    expect(renderToStaticMarkup(<BallotBar state={empty} mini />)).not.toMatch(/no votes/);
    expect(renderToStaticMarkup(<BallotBar state={empty} ended />)).toMatch(/no votes cast</);
  });
});

describe('username names', () => {
  it('should map a domain document and remember its spelling', () => {
    expect(toDpnsName({ label: 'Alice', $ownerId: 'O', $createdAt: 1741362177861 })).toEqual({
      label: 'Alice',
      ownerId: 'O',
      createdAtMs: 1741362177861,
    });
    expect(toDpnsName({ label: '' })).toBeUndefined();
    const key = dpnsPollKey('a11ce');
    expect(dpnsSpelling(summary(key))).toEqual({ label: 'a11ce', known: false });
    rememberDpnsSpelling('a11ce', 'Alice');
    // A spelling that does not normalize to the label is refused.
    rememberDpnsSpelling('a11ce', 'Mallory');
    expect(dpnsSpelling(summary(key))).toEqual({ label: 'Alice', known: true });
  });

  it('should batch name lookups 100 labels at a time', async () => {
    const queries: Array<{ where: unknown[][] }> = [];
    const sdk = {
      version: () => 1,
      documents: {
        async query(q: { where: unknown[][] }) {
          queries.push(q);
          const labels = q.where[1][2] as string[];
          return new Map(
            labels
              .filter((l) => l !== 'locked')
              .map((l) => [l, { toJSON: () => ({ label: l.toUpperCase(), normalizedLabel: l }), free: () => {} }]),
          );
        },
      },
    } as unknown as EvoSDK;
    const labels = [...Array.from({ length: 150 }, (_, i) => `n${i}`), 'locked'];
    const names = await fetchDpnsNames(sdk, labels);
    expect(queries).toHaveLength(2);
    expect(queries[0].where[1]).toEqual(['normalizedLabel', 'in', labels.slice(0, 100)]);
    expect(names.size).toBe(150);
    expect(names.has('locked')).toBe(false);
  });
});

describe('archive slices', () => {
  it('should cover the index in contiguous slices', () => {
    expect(archiveSlices(['m'])).toEqual([{ from: undefined, to: 'm' }, { from: 'm', to: undefined }]);
  });

  it('should start a range inclusively, stop at its end, and merge slices', async () => {
    const all = ['a', 'b', 'c', 'm', 'n', 'z'];
    const queries: Record<string, unknown>[] = [];
    const sdk = {
      group: {
        async contestedResources(q: Record<string, unknown>) {
          queries.push(q);
          const at = q.startAtValue as string | undefined;
          const from = at === undefined ? 0 : all.findIndex((x) => (q.startAtValueIncluded ? x >= at : x > at));
          return from < 0 ? [] : all.slice(from, from + (q.limit as number));
        },
      },
    } as unknown as EvoSDK;
    const sweep = {
      source: 'test',
      contractId: 'c',
      documentTypeName: 'd',
      indexName: 'i',
      prefix: [],
      toKey: (r: unknown) => dpnsPollKey(r as string),
    };
    const slices = archiveSlices(['m']).map(({ from, to }) =>
      sweepContestedResources(sdk, sweep, {
        pageSize: 2,
        range: { from, stop: to === undefined ? undefined : (r) => (r as string) >= to },
      }),
    );
    const pages: ArchivePage[] = [];
    for await (const page of mergeSweeps(slices)) pages.push(page);
    const labels = pages.flatMap((p) => p.keys.map((k) => (k.indexValues[1] as { value: string }).value));
    expect(labels.sort()).toEqual(all);
    expect(queries.find((q) => q.startAtValue === 'm')).toMatchObject({ startAtValueIncluded: true });
  });
});

describe('tally queue', () => {
  it('should run only what is wanted now, each key once, within the limit', async () => {
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const q = createWantQueue<number>(2, String, async (n) => {
      started.push(n);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    q.want([1, 2, 3, 4]);
    // The tab changed: 3 and 4 are no longer wanted; 1 is already running.
    q.want([1, 9]);
    await new Promise((r) => setTimeout(r, 40));
    expect(started).toEqual([1, 2, 9]);
    expect(peak).toBe(2);
  });
});

describe('sources and reports', () => {
  it('should read only the lists a tab shows, and no charter archive on mainnet', () => {
    expect(sourcesFor('testnet', 'charter').map((s) => s.id)).toEqual(['active', 'charter archive']);
    expect(sourcesFor('testnet', 'generic').map((s) => s.id)).toEqual(['active']);
    expect(sourcesFor('testnet').map((s) => s.id)).toEqual(['active', 'dpns archive', 'charter archive']);
    expect(sourcesFor('mainnet').map((s) => s.id)).toEqual(['active', 'dpns archive']);
  });

  it('should combine per-source runs', () => {
    const run = (id: string, status: 'streaming' | 'done' | 'error', seen = 1) => ({
      id,
      status,
      failures: status === 'error' ? [{ source: id, message: 'x' }] : [],
      caps: [],
      seen,
    });
    expect(combineReports([run('a', 'done'), run('b', 'streaming')])).toMatchObject({ status: 'streaming', finished: ['a'] });
    expect(combineReports([run('a', 'done'), run('b', 'error', 0)]).status).toBe('partial');
    expect(combineReports([run('a', 'error', 0)]).status).toBe('error');
  });
});

describe('result cache', () => {
  it('should store decided results without documents', () => {
    const key = dpnsPollKey('alice');
    const c = contest(key, [2, 1], { at: 9 });
    c.tally.contenders[0].document = { label: 'Alice' };
    expect(isStorable(c)).toBe(true);
    expect(isStorable(contest(key, [1]))).toBe(false);
    if (!isStorable(c)) throw new Error('unreachable');
    const result = resultOf(c);
    expect(result.tally.contenders[0]).toEqual({ identityId: 'id0', votes: 2 });
    const back = cachedContest({ id: `testnet|${c.keyString}`, network: 'testnet', keyString: c.keyString, result });
    expect(back?.winner).toEqual(c.winner);
    expect(back?.key).toEqual(key);
  });

  it('should be an empty cache without IndexedDB', async () => {
    const dir = await loadCachedDirectory('testnet');
    expect(dir.results.size).toBe(0);
    expect(dir.complete.size).toBe(0);
  });
});
