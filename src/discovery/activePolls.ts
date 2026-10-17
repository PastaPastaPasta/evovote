import type { EvoSDK } from '@dashevo/evo-sdk';
import { errorMessage } from '../sdk/errors';
import { freeQuietly } from '../sdk/free';
import type { ContestSummary } from '../model/contest';
import { encodePollKey, pollKeyFromSdkPoll, type SdkVotePollLike } from '../model/pollKey';
import type { Cap, Failure } from './types';

/**
 * Polls per page. The node's limit has been reported to count polls, not the
 * timestamp buckets they come back in (Yappr, 4.2 betas); the walk below is
 * correct either way.
 */
export const ACTIVE_PAGE = 100;
/** 20 pages = 2000 polls before the walk stops and reports a cap. */
export const ACTIVE_MAX_PAGES = 20;
/**
 * The latest end a live poll can have from now. Generic polls end within
 * two weeks on mainnet (90 minutes on testnet), but a moderator election
 * runs on its target's own windows, each up to four weeks, so its end can be
 * eight weeks out. Plus a day of slack.
 */
export const ACTIVE_HORIZON_MS = (2 * 28 + 1) * 24 * 3_600_000;

export interface ActivePolls {
  /** Ascending by end time; deduplicated by key. */
  polls: ContestSummary[];
  failures: Failure[];
  caps: Cap[];
}

/** What an entry of votePollsByEndDate looks like to this module. */
export interface EndDateEntryLike {
  timestampMs: bigint | number;
  votePolls: unknown[];
  free?: () => void;
}

/** A wasm VotePoll as read from chain, kept for voting (see livePollFor). */
type LivePoll = SdkVotePollLike & { free?: () => void };

// Poll objects read from chain, by key string. Voting must sign over the
// poll exactly as stored: `new VotePoll(...)` cannot reproduce Identifier,
// integer or bytes index values (see isConstructible), so those polls are
// only votable through the object read here.
const livePolls = new Map<string, LivePoll>();

/** The chain's own VotePoll object for a key, if the last walk saw it. */
export function livePollFor(keyString: string): unknown {
  return livePolls.get(keyString);
}

/**
 * Keep the first object seen for a key and free later copies. A poll never
 * changes, and a vote in flight may still hold the first one: the SDK only
 * clones it after an await, so freeing it here could pull it out from under
 * that vote.
 */
function remember(keyString: string, poll: LivePoll): void {
  const previous = livePolls.get(keyString);
  if (!previous) livePolls.set(keyString, poll);
  else if (previous !== poll) freeQuietly(poll);
}

/**
 * Map one page of entries to summaries. Pure apart from `remember`;
 * exported for tests. Unreadable polls are counted, not silently dropped.
 */
export function readEntries(
  entries: EndDateEntryLike[],
  keep: (keyString: string, poll: LivePoll) => void = remember,
): {
  summaries: ContestSummary[];
  pollCount: number;
  unreadable: number;
  first?: bigint;
  last?: bigint;
} {
  const summaries: ContestSummary[] = [];
  let pollCount = 0;
  let unreadable = 0;
  let first: bigint | undefined;
  let last: bigint | undefined;
  for (const entry of entries) {
    let ts: bigint;
    let polls: unknown[];
    try {
      ts = BigInt(entry.timestampMs);
      polls = Array.from(entry.votePolls ?? []);
    } catch {
      unreadable++;
      continue;
    }
    first ??= ts;
    last = ts;
    for (const poll of polls) {
      pollCount++;
      try {
        const key = pollKeyFromSdkPoll(poll as SdkVotePollLike);
        const keyString = encodePollKey(key);
        keep(keyString, poll as LivePoll);
        summaries.push({ key, keyString, endsAtMs: Number(ts) });
      } catch {
        unreadable++;
      }
    }
  }
  return { summaries, pollCount, unreadable, first, last };
}

/**
 * Every poll still in the end-date index (open, or ended but not yet
 * finalized), walked forward in end time.
 *
 * Paging uses time bounds: each page starts at the previous page's last
 * timestamp, passing its bigint back (rc.4 accepts number | bigint). A full
 * page may have cut its last timestamp's group short, so the next page
 * re-reads that timestamp (duplicates are dropped by key); a page that is all
 * one timestamp cannot advance that way, so the walk moves past it.
 *
 * `offset` is NOT a usable fallback in rc.4: the node refuses any offset
 * ("offset field is internal and must be set to None", docs/V2_NOTES.md).
 * If the bounded query itself fails, the walk is retried once without the
 * upper bound.
 */
export async function fetchActivePolls(
  sdk: EvoSDK,
  opts: { now?: number; pageSize?: number; maxPages?: number } = {},
): Promise<ActivePolls> {
  const now = opts.now ?? Date.now();
  const pageSize = opts.pageSize ?? ACTIVE_PAGE;
  const maxPages = opts.maxPages ?? ACTIVE_MAX_PAGES;
  const failures: Failure[] = [];
  const caps: Cap[] = [];

  const walk = async (
    upper: number | undefined,
    walkFailures: Failure[],
  ): Promise<ContestSummary[]> => {
    const byKey = new Map<string, ContestSummary>();
    let lower: { startTimeMs: bigint; startTimeIncluded: boolean } | undefined;
    for (let page = 0; page < maxPages; page++) {
      const entries = (await sdk.voting.votePollsByEndDate({
        ...lower,
        ...(upper !== undefined ? { endTimeMs: upper, endTimeIncluded: true } : {}),
        orderAscending: true,
        limit: pageSize,
      })) as unknown as EndDateEntryLike[];
      let read;
      try {
        read = readEntries(entries);
      } finally {
        entries.forEach(freeQuietly);
      }
      for (const s of read.summaries) byKey.set(s.keyString, s);
      if (read.unreadable > 0) {
        walkFailures.push({
          source: 'active polls',
          message: `${read.unreadable} poll(s) on page ${page + 1} could not be read`,
        });
      }
      const full = read.pollCount >= pageSize || entries.length >= pageSize;
      if (!full || read.first === undefined || read.last === undefined) {
        return [...byKey.values()];
      }
      if (read.first === read.last) {
        // A full page of one timestamp: the rest of that timestamp cannot be
        // reached (no offset), so the walk moves past it and says so.
        walkFailures.push({
          source: 'active polls',
          message: `more than ${pageSize} polls end at ${new Date(Number(read.last)).toISOString()}; some of them are not listed`,
        });
      }
      lower = { startTimeMs: read.last, startTimeIncluded: read.first !== read.last };
    }
    caps.push({ source: 'active polls', limit: byKey.size });
    return [...byKey.values()];
  };

  let polls: ContestSummary[] = [];
  try {
    const walkFailures: Failure[] = [];
    polls = await walk(now + ACTIVE_HORIZON_MS, walkFailures);
    failures.push(...walkFailures);
  } catch (boundedError) {
    // The first attempt's partial failures are discarded with its results.
    const walkFailures: Failure[] = [];
    try {
      polls = await walk(undefined, walkFailures);
      failures.push(...walkFailures);
      failures.push({
        source: 'active polls',
        message: `time-bounded query failed, read without an upper bound: ${errorMessage(boundedError)}`,
      });
    } catch (e) {
      failures.push({ source: 'active polls', message: errorMessage(e) });
    }
  }
  polls.sort((a, b) => (a.endsAtMs ?? 0) - (b.endsAtMs ?? 0));
  return { polls, failures, caps };
}

const ACTIVE_TTL_MS = 60_000;
let activeCache: { at: number; promise: Promise<ActivePolls> } | null = null;

/** fetchActivePolls, shared for a minute between the list and contest pages. */
export function getActivePolls(sdk: EvoSDK, force = false): Promise<ActivePolls> {
  if (!force && activeCache && Date.now() - activeCache.at < ACTIVE_TTL_MS) {
    return activeCache.promise;
  }
  const entry = { at: Date.now(), promise: fetchActivePolls(sdk) };
  activeCache = entry;
  // A result with failures is not reused: the next caller retries.
  entry.promise.then(
    (r) => {
      if (r.failures.length > 0 && activeCache === entry) activeCache = null;
    },
    () => {
      if (activeCache === entry) activeCache = null;
    },
  );
  return entry.promise;
}
