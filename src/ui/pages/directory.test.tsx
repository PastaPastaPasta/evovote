import type { EvoSDK } from '@dashevo/evo-sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  labelOf,
  normalizedUsername,
  rememberDpnsSpelling,
  toDpnsName,
} from '../../kinds/dpns';
import { kindFor, sourcesFor } from '../../kinds/registry';
import type { Contest, ContestSummary } from '../../model/contest';
import { encodePollKey, type PollKey } from '../../model/pollKey';
import { BallotBar } from '../components/BallotBar';
import {
  completeKinds,
  decidedWords,
  emptyMessage,
  isRemembered,
  matchesNeedle,
  mergeByKey,
  needsName,
  orderEnded,
  outcomeOf,
  rowLabel,
  showDecided,
  shownEnded,
  statusSentence,
  tallyWants,
  toNeedle,
  winnerNameOf,
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
  teamNames: {},
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

  it("should name a moderator election's winner by its team, else the leader", () => {
    const c = summary(charterPollKey(TARGET));
    const kind = kindFor(c.key);
    const state = { [c.keyString]: contest(c.key, [5, 2], { id: 'id0' }) };
    const leader = facts({ states: state, identityNames: { id0: ['bob.dash'] } });
    expect(winnerNameOf(c, leader)).toBe('bob.dash');
    const teamNames = { [c.keyString]: { winnerId: 'id0', name: 'Team B' } };
    const team = facts({ states: state, identityNames: { id0: ['bob.dash'] }, teamNames });
    expect(winnerNameOf(c, team)).toBe('Team B');
    expect(matchesNeedle(c, kind, team, toNeedle('team b')!)).toBe(true);
    expect(matchesNeedle(c, kind, team, toNeedle('bob')!)).toBe(true);
    // A team read for another winner is not this one's.
    const stale = facts({
      states: { [c.keyString]: contest(c.key, [2, 5], { id: 'id1' }) },
      identityNames: { id1: ['carol.dash'] },
      teamNames,
    });
    expect(winnerNameOf(c, stale)).toBe('carol.dash');
    expect(matchesNeedle(c, kind, stale, toNeedle('team b')!)).toBe(false);
    // A username contest never takes a team name.
    const d = summary(dpnsPollKey('b0b'));
    const dpns = facts({
      states: { [d.keyString]: contest(d.key, [3, 1], { id: 'id0' }) },
      identityNames: { id0: ['bob.dash', 'carol.dash'] },
      teamNames: { [d.keyString]: { winnerId: 'id0', name: 'Team B' } },
    });
    expect(winnerNameOf(d, dpns)).toBe('carol.dash');
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

describe('first paint', () => {
  const named = summary(dpnsPollKey('a11ce'));
  const undated = summary(dpnsPollKey('10cked'));
  const failed = summary(dpnsPollKey('fa11ed'));
  const f = facts({
    names: { a11ce: { label: 'Alice', createdAtMs: 5 } },
    states: { [failed.keyString]: 'error' },
  });

  it('should show only placed rows until the order is final, then every row', () => {
    // The undated row would sort last by name, then jump once its tally lands.
    expect(shownEnded([undated, named, failed], f, false)).toEqual([named, failed]);
    expect(shownEnded([undated, named, failed], f, true)).toEqual([undated, named, failed]);
  });

  it('should show the decided list once names are in and the placed rows fill the first page', () => {
    const s = { orderFinal: false, openRead: true, namesKnown: true, placed: 25, total: 1000, page: 25 };
    expect(showDecided(s)).toBe(true);
    // Open contests unknown, or names still coming: the order is not worth showing.
    expect(showDecided({ ...s, openRead: false })).toBe(false);
    expect(showDecided({ ...s, namesKnown: false })).toBe(false);
    // A short list (five moderator elections) comes in whole, not row by row.
    expect(showDecided({ ...s, placed: 3, total: 5 })).toBe(false);
    expect(showDecided({ ...s, placed: 3, total: 5, orderFinal: true })).toBe(true);
    // A complete cache shows before Platform has said anything.
    expect(showDecided({ ...s, openRead: false, namesKnown: false, placed: 0, orderFinal: true })).toBe(true);
  });

  it('should read open rows, then unread expired, on-screen and undated rows, and nothing else', () => {
    const open = summary(dpnsPollKey('0pen'), 9_999);
    const expired = summary(dpnsPollKey('exp1red'), 1);
    const offScreen = summary(dpnsPollKey('0ff'));
    const read = summary(dpnsPollKey('read'));
    const g = facts({ ...f, states: { ...f.states, [read.keyString]: contest(read.key, [1], { at: 3 }) } });
    const wants = tallyWants({
      open: [open],
      expired: [expired],
      visible: [named, read, expired],
      unplaced: [undated, named],
      facts: g,
    });
    expect(wants).toEqual([open, expired, named, undated]);
    expect(wants).not.toContain(offScreen);
    // An open row is asked for even with a state: its full read runs once.
    const openRead = facts({ states: { [open.keyString]: contest(open.key, [1]) } });
    expect(tallyWants({ open: [open], expired: [], visible: [], unplaced: [], facts: openRead })).toEqual([open]);
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

  it('should keep the other names of a batch when one document cannot be read, and free them all', async () => {
    let freed = 0;
    const doc = (l: string, bad = false) => ({
      toJSON: () => {
        if (bad) throw new Error('bad document');
        return { label: l.toUpperCase(), normalizedLabel: l };
      },
      free: () => {
        freed++;
      },
    });
    const sdk = {
      version: () => 1,
      documents: {
        query: async () => new Map([['a', doc('a')], ['b', doc('b', true)], ['c', doc('c')]]),
      },
    } as unknown as EvoSDK;
    const names = await fetchDpnsNames(sdk, ['a', 'b', 'c']);
    expect([...names.keys()]).toEqual(['a', 'c']);
    expect(freed).toBe(3);
  });

  it('should ask for a name unless it is known or the contest had no winner to own one', () => {
    const result = (kind: 'identity' | 'locked') => ({
      tally: { contenders: [], abstain: 0, lock: 0, total: 0 },
      winner: { kind, rawKind: kind },
    });
    const base = { id: 'x', network: 'testnet' as const, keyString: 'k' };
    expect(needsName(undefined)).toBe(true);
    expect(needsName({ ...base, name: { label: 'Bob' } })).toBe(false);
    // An awarded result carries no spelling: still ask.
    expect(needsName({ ...base, result: result('identity') })).toBe(true);
    expect(needsName({ ...base, result: result('locked') })).toBe(false);
  });

  it('should strip ".dash" and normalize a username', () => {
    expect(normalizedUsername('Bob.DASH')).toBe('b0b');
    expect(normalizedUsername('alice')).toBe('a11ce');
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

  it('should read a label from a string or array resource', () => {
    expect(labelOf('bob')).toBe('bob');
    expect(labelOf(['dash', 'bob'])).toBe('bob');
    expect(labelOf(42)).toBeUndefined();
    expect(labelOf([])).toBeUndefined();
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

  it('should report a sliced archive cap once per source, with all it read', () => {
    const run = (id: string, seen: number, caps: { source: string; limit: number }[]) => ({
      id,
      status: 'done' as const,
      failures: [],
      caps,
      seen,
    });
    const report = combineReports([
      run('dpns archive', 9100, [
        { source: 'DPNS archive', limit: 2000 },
        { source: 'DPNS archive', limit: 2000 },
      ]),
      run('charter archive', 2000, [{ source: 'moderator election archive', limit: 2000 }]),
      run('active', 3, []),
    ]);
    expect(report.caps).toEqual([
      { source: 'DPNS archive', limit: 9100 },
      { source: 'moderator election archive', limit: 2000 },
    ]);
  });
});

describe('directory list state', () => {
  const base = {
    connected: true,
    ready: true,
    openRead: true,
    openFailed: false,
    openCount: 0,
    endedCount: 3,
    decided: '3 username contests',
  };

  it('should say nothing about open contests until the active polls are read', () => {
    const text = (s: { lead?: string; rest?: string }) => `${s.lead ?? ''} ${s.rest ?? ''}`;
    // A cached, complete list while Platform connects.
    const connecting = statusSentence({ ...base, connected: false, openRead: false });
    expect(text(connecting)).not.toMatch(/Nothing is open/);
    expect(connecting.rest).toBe('3 username contests decided so far. Connecting to Dash Platform…');
    const checking = statusSentence({ ...base, openRead: false });
    expect(text(checking)).not.toMatch(/Nothing is open/);
    expect(checking.rest).toMatch(/Checking for open contests…$/);
    expect(statusSentence({ ...base, connected: false, ready: false, openRead: false, endedCount: 0 }).rest).toBe(
      'Connecting to Dash Platform…',
    );
    // The app's own words for what it is doing while the SDK loads.
    expect(
      statusSentence({ ...base, connected: false, ready: false, openRead: false, endedCount: 0, connecting: 'Loading the Platform SDK…' })
        .rest,
    ).toBe('Loading the Platform SDK…');
    expect(statusSentence({ ...base, ready: false, openRead: false, endedCount: 0 }).rest).toBe(
      'Reading contests from Platform…',
    );
    // Once they are read.
    expect(statusSentence(base)).toEqual({
      lead: 'Nothing is open for voting right now.',
      rest: '3 username contests have been decided.',
    });
    expect(statusSentence({ ...base, openCount: 2, nextCloses: '5m' })).toEqual({
      lead: '2 contests open for voting.',
      rest: 'The next closes in 5m. 3 username contests decided so far.',
    });
    expect(statusSentence({ ...base, openCount: 1, ready: false }).rest).toBe('Reading decided contests…');
    // A failed active-polls read never becomes "nothing is open".
    expect(statusSentence({ ...base, openFailed: true })).toEqual({
      rest: 'Open contests could not be read from Platform. 3 username contests decided so far.',
    });
  });

  it('should render a cached, complete directory without Platform and claim nothing about open contests', async () => {
    vi.resetModules();
    const cache = await import('../../discovery/resultCache');
    const { OverviewPage } = await import('./OverviewPage');
    const dpns = await import('../../kinds/dpns');
    await cache.loadCachedDirectory('testnet');
    const c = contest(dpns.dpnsPollKey('a11ce'), [2, 1], { at: Date.UTC(2026, 9, 1) });
    if (!cache.isStorable(c)) throw new Error('unreachable');
    cache.saveCachedResult('testnet', c.keyString, { result: cache.resultOf(c), name: { label: 'Alice', createdAtMs: 1 } });
    for (const k of ['dpns', 'charter', 'generic']) cache.markDirectoryComplete('testnet', k);
    const html = renderToStaticMarkup(<OverviewPage network="testnet" />);
    expect(html).toContain('a11ce.dash — decided');
    expect(html).toContain('1 username contest decided so far. Connecting to Dash Platform…');
    expect(html).not.toMatch(/Nothing is (open|contested)/);
    expect(html).not.toContain('Open for voting');
  });

  it('should keep the cached directory on screen when Platform cannot be reached', async () => {
    vi.resetModules();
    const cache = await import('../../discovery/resultCache');
    const { OverviewPage } = await import('./OverviewPage');
    const dpns = await import('../../kinds/dpns');
    await cache.loadCachedDirectory('testnet');
    const c = contest(dpns.dpnsPollKey('a11ce'), [2, 1], { at: Date.UTC(2026, 9, 1) });
    if (!cache.isStorable(c)) throw new Error('unreachable');
    cache.saveCachedResult('testnet', c.keyString, { result: cache.resultOf(c), name: { label: 'Alice', createdAtMs: 1 } });
    // Not marked complete: offline, whatever is cached shows anyway.
    const html = renderToStaticMarkup(<OverviewPage network="testnet" sdkError="connect failed: no nodes" />);
    expect(html).toContain('Could not connect to Dash Platform.');
    expect(html).toContain('Showing the results saved on this device.');
    expect(html).toContain('connect failed: no nodes');
    expect(html).toContain('a11ce.dash — decided');
    expect(html).toContain('data-loading="false"');
    expect(html).not.toContain('skeleton');
    expect(html).not.toMatch(/Nothing is (open|contested)|Connecting to Dash Platform/);
  });

  it('should say only that Platform is out of reach when nothing is cached', async () => {
    vi.resetModules();
    const cache = await import('../../discovery/resultCache');
    const { OverviewPage } = await import('./OverviewPage');
    await cache.loadCachedDirectory('testnet');
    const html = renderToStaticMarkup(<OverviewPage network="testnet" sdkError="boom" />);
    expect(html).toContain('Could not connect to Dash Platform.');
    expect(html).toContain('Check your connection and try again.');
    expect(html).not.toContain('skeleton');
    expect(html).not.toMatch(/Nothing is (open|contested)|No contests/);
  });

  it('should only call a tab empty once Platform has been read in full', () => {
    const s = {
      filter: '',
      connected: true,
      openRead: true,
      status: 'done' as const,
      failures: 0,
      network: 'testnet' as const,
    };
    expect(emptyMessage({ ...s, connected: false })).toBeUndefined();
    expect(emptyMessage({ ...s, openRead: false })).toBeUndefined();
    expect(emptyMessage({ ...s, status: 'streaming' })).toBeUndefined();
    expect(emptyMessage({ ...s, openRead: false, filter: ' bob ' })).toBe('No contests match “bob”.');
    expect(emptyMessage(s)).toBe('Nothing is contested on testnet right now.');
    expect(emptyMessage({ ...s, kindFilter: 'charter', heading: 'Moderator elections' })).toBe(
      'No moderator elections on testnet yet.',
    );
    expect(emptyMessage({ ...s, status: 'partial', failures: 1 })).toMatch(/some reads failed/);
    expect(emptyMessage({ ...s, status: 'error', failures: 1 })).toMatch(/could not be read/);
  });

  it('should count decided rows by kind, in tab order', () => {
    const rows = [summary(dpnsPollKey('a')), summary(charterPollKey(TARGET)), summary(dpnsPollKey('b'))];
    expect(decidedWords(rows, ['dpns', 'charter', 'generic'])).toBe('2 username contests and 1 moderator election');
    expect(decidedWords([], ['dpns'])).toBe('');
  });

  it('should merge rows by key, keeping the list when nothing is new', () => {
    const a = summary(dpnsPollKey('a'));
    const b = summary(dpnsPollKey('b'));
    const list = [a];
    expect(mergeByKey(list, [a])).toBe(list);
    expect(mergeByKey(list, [b, a, b])).toEqual([a, b]);
  });
});

describe('directory completeness', () => {
  const named = summary(dpnsPollKey('a11ce'));
  const locked = summary(dpnsPollKey('10cked'));
  const election = summary(charterPollKey(TARGET));
  const remembered = facts({
    names: { a11ce: { label: 'Alice', createdAtMs: 5 } },
    states: {
      [locked.keyString]: contest(locked.key, [1], { locked: true, at: 9 }, { lock: 3 }),
      [election.keyString]: contest(election.key, [2, 1], { at: 9 }),
    },
  });
  const report = { failures: [], caps: [] };
  const args = { kinds: ['dpns', 'charter'] as const, ordered: () => true, rows: [named, locked, election] };

  it('should cache a kind as complete only when every row comes back from the cache', () => {
    expect(completeKinds({ ...args, kinds: [...args.kinds], facts: remembered, report })).toEqual(['dpns', 'charter']);
    // A failed tally, an undecided result, or a tally never read is not remembered.
    const errored = facts({ ...remembered, states: { ...remembered.states, [locked.keyString]: 'error' } });
    expect(isRemembered(locked, errored)).toBe(false);
    expect(completeKinds({ ...args, kinds: [...args.kinds], facts: errored, report })).toEqual(['charter']);
    const undecided = facts({ ...remembered, states: { ...remembered.states, [election.keyString]: contest(election.key, [2]) } });
    expect(completeKinds({ ...args, kinds: [...args.kinds], facts: undecided, report })).toEqual(['dpns']);
    expect(isRemembered(summary(dpnsPollKey('unread')), remembered)).toBe(false);
  });

  it('should not cache anything as complete after a failure or a cap', () => {
    const kinds = [...args.kinds];
    expect(completeKinds({ ...args, kinds, facts: remembered, report: { failures: [], caps: [{ source: 'x', limit: 2000 }] } })).toEqual([]);
    expect(completeKinds({ ...args, kinds, facts: remembered, report: { failures: [{ source: 'x', message: 'm' }], caps: [] } })).toEqual([]);
    expect(completeKinds({ ...args, kinds, facts: remembered, report, ordered: (k) => k === 'charter' })).toEqual(['charter']);
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('should run without a cache when IndexedDB never answers', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    // A WebKit hang: open() returns a request that never fires an event.
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    const cache = await import('../../discovery/resultCache');
    const loading = cache.loadCachedDirectory('testnet');
    await vi.advanceTimersByTimeAsync(cache.OPEN_TIMEOUT_MS);
    const dir = await loading;
    expect(dir.results.size).toBe(0);
    cache.saveCachedResult('testnet', 'k', { name: { label: 'Bob' } });
    expect(cache.peekCachedDirectory('testnet')?.results.get('k')?.name).toEqual({ label: 'Bob' });
  });

  it('should still write to IndexedDB when its open answers after the timeout', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const req: { result?: unknown; onsuccess?: () => void } = {};
    vi.stubGlobal('indexedDB', { open: () => req });
    const cache = await import('../../discovery/resultCache');
    const loading = cache.loadCachedDirectory('testnet');
    await vi.advanceTimersByTimeAsync(cache.OPEN_TIMEOUT_MS);
    expect((await loading).results.size).toBe(0);
    const puts: unknown[] = [];
    req.result = { transaction: () => ({ objectStore: () => ({ put: (r: unknown) => puts.push(r) }) }) };
    req.onsuccess?.();
    cache.saveCachedResult('testnet', 'k', { name: { label: 'Bob' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts).toEqual([expect.objectContaining({ keyString: 'k', name: { label: 'Bob' } })]);
  });

  it('should keep a complete marker set before the cache has loaded', async () => {
    vi.resetModules();
    const cache = await import('../../discovery/resultCache');
    cache.markDirectoryComplete('testnet', 'charter');
    const dir = await cache.loadCachedDirectory('testnet');
    await Promise.resolve();
    expect(dir.complete.has('charter')).toBe(true);
  });

  it('should be an empty cache without IndexedDB', async () => {
    const dir = await loadCachedDirectory('testnet');
    expect(dir.results.size).toBe(0);
    expect(dir.complete.size).toBe(0);
  });
});
