import type { EvoSDK } from '@dashevo/evo-sdk';
import type { ContestSummary } from '../model/contest';
import { errorMessage } from '../sdk/errors';
import { encodePollKey } from '../model/pollKey';
import { getActivePolls } from './activePolls';
import type { ArchivePage } from './archive';
import type { Cap, Failure } from './types';

/**
 * Where contests come from: every poll still in the end-date index
 * (`active`, one read), or one kind's archive of decided contests whose polls
 * are gone (`archive`, page by page). Each source streams on its own, so a
 * list reads only the sources it shows: the moderator elections tab never
 * waits on a thousand username archive entries.
 */
export type StreamPhase = 'active' | 'archive';

export interface ContestSource {
  /** Stable id, e.g. "active" or "dpns archive"; runs are shared by id. */
  id: string;
  phase: StreamPhase;
  /** The kind this archive belongs to (archives only). */
  kindId?: string;
  read: (sdk: EvoSDK) => AsyncIterable<SummaryPage>;
}

/** One page of a source: some contests, and any failure or cap met on the way. */
export interface SummaryPage {
  list: ContestSummary[];
  failures?: Failure[];
  caps?: Cap[];
}

/** An archive sweep's pages as summary pages. */
export async function* archiveSummaries(pages: AsyncIterable<ArchivePage>): AsyncGenerator<SummaryPage> {
  for await (const page of pages) {
    yield {
      list: page.keys.map((key) => ({ key, keyString: encodePollKey(key) })),
      failures: page.failure ? [page.failure] : undefined,
      caps: page.cap ? [page.cap] : undefined,
    };
  }
}

export interface ContestBatch {
  source: string;
  phase: StreamPhase;
  list: ContestSummary[];
}

/** `partial`: some read failed, so contests may be missing. */
export type StreamStatus = 'streaming' | 'done' | 'partial' | 'error';

export interface StreamReport {
  status: StreamStatus;
  failures: Failure[];
  caps: Cap[];
  /** Sources that have finished (successfully or not), by id. */
  finished: string[];
}

interface Subscriber {
  onBatch: (batch: ContestBatch) => void;
  onReport: () => void;
}

interface SourceRun {
  /** Last activity while streaming (a wedge is a long silence); completion time after. */
  at: number;
  status: StreamStatus;
  batches: ContestBatch[];
  failures: Failure[];
  caps: Cap[];
  seen: number;
  listeners: Set<Subscriber>;
}

/** The poll-key source of the active polls, shared by every list. */
export const ACTIVE_SOURCE: ContestSource = {
  id: 'active',
  phase: 'active',
  async *read(sdk) {
    const active = await getActivePolls(sdk);
    yield { list: active.polls, failures: active.failures, caps: active.caps };
  },
};

const CONTESTS_TTL_MS = 60_000;
// A run that goes quiet this long (one wedged SDK call) is not joined.
const STREAM_DEADLINE_MS = 120_000;

const runs = new Map<string, SourceRun>();

function startRun(sdk: EvoSDK, source: ContestSource): SourceRun {
  const run: SourceRun = {
    at: Date.now(),
    status: 'streaming',
    batches: [],
    failures: [],
    caps: [],
    seen: 0,
    listeners: new Set(),
  };
  const seen = new Set<string>();
  const notify = () => {
    for (const listener of run.listeners) listener.onReport();
  };

  void (async () => {
    try {
      for await (const page of source.read(sdk)) {
        run.at = Date.now();
        run.failures.push(...(page.failures ?? []));
        run.caps.push(...(page.caps ?? []));
        const fresh = page.list.filter((c) => !seen.has(c.keyString));
        for (const c of fresh) seen.add(c.keyString);
        run.seen = seen.size;
        if (fresh.length > 0) {
          const batch = { source: source.id, phase: source.phase, list: fresh };
          run.batches.push(batch);
          for (const listener of run.listeners) listener.onBatch(batch);
        }
        notify();
      }
    } catch (e) {
      run.failures.push({ source: source.id, message: errorMessage(e) });
    }
    run.at = Date.now();
    run.status = run.failures.length === 0 ? 'done' : seen.size === 0 ? 'error' : 'partial';
    notify();
    run.listeners.clear();
  })();

  return run;
}

function runFor(sdk: EvoSDK, source: ContestSource): SourceRun {
  // Reuse an in-progress run (unless wedged past its deadline) or a clean
  // completed one inside the TTL. Failed and partial runs always restart.
  const run = runs.get(source.id);
  const age = run ? Date.now() - run.at : Infinity;
  if (run?.status === 'streaming' && age < STREAM_DEADLINE_MS) return run;
  if (run?.status === 'done' && age < CONTESTS_TTL_MS) return run;
  const fresh = startRun(sdk, source);
  runs.set(source.id, fresh);
  return fresh;
}

/** The combined report of several source runs. */
export function combineReports(
  sources: readonly { id: string; status: StreamStatus; failures: Failure[]; caps: Cap[]; seen: number }[],
): StreamReport {
  const failures = sources.flatMap((s) => s.failures);
  // A sliced archive caps per slice: say it once per source, with how many
  // contests that source did read (slices overlap nothing, so `seen` is exact).
  const caps = sources.flatMap((s) =>
    [...new Set(s.caps.map((c) => c.source))].map((source) => ({ source, limit: s.seen })),
  );
  const finished = sources.filter((s) => s.status !== 'streaming').map((s) => s.id);
  let status: StreamStatus;
  if (finished.length < sources.length) status = 'streaming';
  else if (failures.length === 0) status = 'done';
  else status = sources.some((s) => s.seen > 0) ? 'partial' : 'error';
  return { status, failures, caps, finished };
}

/**
 * Subscribe to the contests of some sources. Already-fetched batches replay
 * synchronously (instant back-navigation and tab switches); new ones arrive
 * as pages land, from every source in parallel. Returns an unsubscribe
 * function.
 */
export function subscribeContests(
  sdk: EvoSDK,
  sources: readonly ContestSource[],
  onBatch: (batch: ContestBatch) => void,
  onReport: (report: StreamReport) => void,
): () => void {
  const current = sources.map((source) => ({ id: source.id, run: runFor(sdk, source) }));
  const report = () =>
    onReport(combineReports(current.map(({ id, run }) => ({ id, ...run }))));
  const subscriber: Subscriber = { onBatch, onReport: report };
  for (const { run } of current) {
    for (const batch of run.batches) onBatch(batch);
    if (run.status === 'streaming') run.listeners.add(subscriber);
  }
  report();
  return () => {
    for (const { run } of current) run.listeners.delete(subscriber);
  };
}
