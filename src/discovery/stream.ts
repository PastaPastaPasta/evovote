import type { EvoSDK } from '@dashevo/evo-sdk';
import type { ContestSummary } from '../model/contest';
import { encodePollKey } from '../model/pollKey';
import { getActivePolls } from './activePolls';
import type { ArchivePage } from './archive';
import type { Cap, Failure } from './types';

/** A per-kind sweep of decided contests (ContestKind.archive). */
export interface ArchiveSource {
  kindId: string;
  archive: (sdk: EvoSDK) => AsyncIterable<ArchivePage>;
}

/**
 * Streaming order: every poll still in the end-date index first (one batch,
 * ascending end time), then each kind's archive of decided contests whose
 * polls are gone, page by page. Keys already seen are not repeated.
 */
export type StreamPhase = 'active' | 'archive';

export interface ContestBatch {
  phase: StreamPhase;
  list: ContestSummary[];
}

/** `partial`: some read failed, so contests may be missing. */
export type StreamStatus = 'streaming' | 'done' | 'partial' | 'error';

export interface StreamReport {
  status: StreamStatus;
  failures: Failure[];
  caps: Cap[];
}

interface Subscriber {
  onBatch: (batch: ContestBatch) => void;
  onReport: (report: StreamReport) => void;
}

interface StreamRun {
  at: number;
  sources: readonly ArchiveSource[];
  batches: ContestBatch[];
  report: StreamReport;
  listeners: Set<Subscriber>;
}

const CONTESTS_TTL_MS = 60_000;
// A run that never settles (one wedged SDK call) must not be joined forever.
const STREAM_DEADLINE_MS = 120_000;

let streamRun: StreamRun | null = null;

function startStream(sdk: EvoSDK, sources: readonly ArchiveSource[]): StreamRun {
  const run: StreamRun = {
    at: Date.now(),
    sources,
    batches: [],
    report: { status: 'streaming', failures: [], caps: [] },
    listeners: new Set(),
  };
  const seen = new Set<string>();
  const push = (phase: StreamPhase, list: ContestSummary[]) => {
    const fresh = list.filter((c) => !seen.has(c.keyString));
    for (const c of fresh) seen.add(c.keyString);
    if (fresh.length === 0) return;
    const batch = { phase, list: fresh };
    run.batches.push(batch);
    for (const listener of run.listeners) listener.onBatch(batch);
  };
  const report = (patch: Partial<StreamReport>) => {
    run.report = { ...run.report, ...patch };
    for (const listener of run.listeners) listener.onReport(run.report);
  };

  void (async () => {
    const failures: Failure[] = [];
    const caps: Cap[] = [];
    const active = await getActivePolls(sdk);
    failures.push(...active.failures);
    caps.push(...active.caps);
    push('active', active.polls);
    report({ failures: [...failures], caps: [...caps] });

    for (const source of sources) {
      try {
        for await (const page of source.archive(sdk)) {
          if (page.failure) failures.push(page.failure);
          if (page.cap) caps.push(page.cap);
          push(
            'archive',
            page.keys.map((key) => ({ key, keyString: encodePollKey(key) })),
          );
          if (page.failure || page.cap) report({ failures: [...failures], caps: [...caps] });
        }
      } catch (e) {
        failures.push({ source: `${source.kindId} archive`, message: String(e) });
      }
    }

    run.at = Date.now();
    const status: StreamStatus =
      failures.length === 0 ? 'done' : seen.size === 0 ? 'error' : 'partial';
    report({ status, failures, caps });
    run.listeners.clear();
  })();

  return run;
}

/**
 * Subscribe to the contest stream. Already-fetched batches replay
 * synchronously (instant back-navigation); new ones arrive as pages land.
 * Returns an unsubscribe function.
 */
export function subscribeContests(
  sdk: EvoSDK,
  sources: readonly ArchiveSource[],
  onBatch: (batch: ContestBatch) => void,
  onReport: (report: StreamReport) => void,
): () => void {
  // Reuse an in-progress run (unless wedged past its deadline) or a clean
  // completed one inside the TTL. Failed and partial runs always restart.
  const run = streamRun;
  const reusable =
    run !== null &&
    run.sources === sources &&
    (run.report.status === 'streaming'
      ? Date.now() - run.at < STREAM_DEADLINE_MS
      : run.report.status === 'done' && Date.now() - run.at < CONTESTS_TTL_MS);
  const current = reusable ? run : (streamRun = startStream(sdk, sources));
  for (const batch of current.batches) onBatch(batch);
  onReport(current.report);
  if (current.report.status !== 'streaming') return () => {};
  const subscriber: Subscriber = { onBatch, onReport };
  current.listeners.add(subscriber);
  return () => {
    current.listeners.delete(subscriber);
  };
}
