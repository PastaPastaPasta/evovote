import { forEachConcurrent } from '../discovery/concurrency';
import { describeVoteError, type DescribedError } from './refusals';

/** At most this many masternodes broadcast at once. */
export const MAX_PARALLEL_MASTERNODES = 8;

export interface BroadcastJob {
  /** Stable id for status updates, e.g. `${mnId}|${keyString}`. */
  id: string;
  mnId: string;
  /** Sign, broadcast and verify one vote; resolves true when read back. */
  run: () => Promise<boolean>;
}

export type JobStatus =
  | { step: 'queued' }
  | { step: 'sending' }
  | { step: 'accepted' }
  /** Broadcast succeeded but the read-back did not show it (yet). */
  | { step: 'unverified' }
  | { step: 'failed'; error: DescribedError };

/**
 * Run vote jobs: sequential per masternode (one identity nonce at a time;
 * parallel votes from one node would race it, 40204), with up to
 * MAX_PARALLEL_MASTERNODES nodes in flight. Never throws; every job ends
 * accepted, unverified or failed. Retry by calling again with the failed jobs.
 */
export async function runBroadcast(
  jobs: readonly BroadcastJob[],
  onStatus: (jobId: string, status: JobStatus) => void,
  concurrency = MAX_PARALLEL_MASTERNODES,
): Promise<Map<string, JobStatus>> {
  const results = new Map<string, JobStatus>();
  const set = (id: string, status: JobStatus) => {
    results.set(id, status);
    onStatus(id, status);
  };
  const byMn = new Map<string, BroadcastJob[]>();
  for (const job of jobs) {
    set(job.id, { step: 'queued' });
    byMn.set(job.mnId, [...(byMn.get(job.mnId) ?? []), job]);
  }
  await forEachConcurrent([...byMn.values()], concurrency, async (mnJobs) => {
    for (const job of mnJobs) {
      set(job.id, { step: 'sending' });
      try {
        set(job.id, { step: (await job.run()) ? 'accepted' : 'unverified' });
      } catch (e) {
        set(job.id, { step: 'failed', error: describeVoteError(e) });
      }
    }
  });
  return results;
}
