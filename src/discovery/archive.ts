import type { EvoSDK } from '@dashevo/evo-sdk';
import { errorMessage } from '../sdk/errors';
import { toQueryValue, type IndexValue } from '../model/indexValue';
import type { PollKey } from '../model/pollKey';
import type { Cap, Failure } from './types';

export const ARCHIVE_PAGE = 100;
/** 20 pages = 2000 resources per index before the sweep stops and reports a cap. */
export const ARCHIVE_MAX_PAGES = 20;

/** One page of an archive sweep: keys, or the failure/cap that ended it. */
export interface ArchivePage {
  keys: PollKey[];
  failure?: Failure;
  cap?: Cap;
}

export interface ContestedResourceSweep {
  /** Shown in failures and caps, e.g. "DPNS archive". */
  source: string;
  contractId: string;
  documentTypeName: string;
  indexName: string;
  /** Fixed leading index values, e.g. DPNS's parent domain ["dash"]. */
  prefix: IndexValue[];
  /**
   * Map one returned resource (the next index value after the prefix, as a
   * plain JS value) to the full key, or undefined to skip it.
   */
  toKey(resource: unknown): PollKey | undefined;
}

/**
 * One slice of an index, for sweeping slices in parallel: start at `from`
 * (inclusive; omitted = the start of the index) and stop before the first
 * resource `stop` accepts (omitted = the end).
 */
export interface SweepRange {
  from?: unknown;
  stop?: (resource: unknown) => boolean;
}

/**
 * Every resource ever contested on one contested index, in index order, via
 * `group.contestedResources` (it lives under `group`, not `voting`). This is
 * how decided contests are found once their poll left the end-date index.
 * Pages resume after the previous page's last value.
 */
export async function* sweepContestedResources(
  sdk: EvoSDK,
  sweep: ContestedResourceSweep,
  opts: { pageSize?: number; maxPages?: number; range?: SweepRange } = {},
): AsyncGenerator<ArchivePage> {
  const pageSize = opts.pageSize ?? ARCHIVE_PAGE;
  const maxPages = opts.maxPages ?? ARCHIVE_MAX_PAGES;
  const stop = opts.range?.stop;
  // A range starts at its `from`, inclusively; later pages resume after the last value.
  let cursor = opts.range?.from;
  let included = cursor !== undefined;
  let seen = 0;
  for (let page = 0; page < maxPages; page++) {
    let resources: unknown[];
    try {
      resources = await sdk.group.contestedResources({
        dataContractId: sweep.contractId,
        documentTypeName: sweep.documentTypeName,
        indexName: sweep.indexName,
        ...(sweep.prefix.length > 0
          ? { startIndexValues: sweep.prefix.map(toQueryValue) }
          : {}),
        limit: pageSize,
        ...(cursor !== undefined ? { startAtValue: cursor, startAtValueIncluded: included } : {}),
      });
    } catch (e) {
      yield { keys: [], failure: { source: sweep.source, message: errorMessage(e) } };
      return;
    }
    const keys: PollKey[] = [];
    let ended = resources.length < pageSize;
    for (const resource of resources) {
      if (stop?.(resource)) {
        // The next slice starts here.
        ended = true;
        break;
      }
      const key = sweep.toKey(resource);
      if (key) keys.push(key);
      seen++;
    }
    yield { keys };
    if (ended) return;
    cursor = resources[resources.length - 1];
    included = false;
  }
  yield { keys: [], cap: { source: sweep.source, limit: seen } };
}

/**
 * Several sweeps at once, pages yielded as they land (in no fixed order).
 * A cursor-paged index can only be walked one page at a time, so slicing it
 * into ranges and walking them in parallel is what makes a long archive fast.
 */
export async function* mergeSweeps(
  sweeps: ReadonlyArray<AsyncIterator<ArchivePage>>,
): AsyncGenerator<ArchivePage> {
  const pending = new Map<number, Promise<{ i: number; r: IteratorResult<ArchivePage> }>>();
  const next = (i: number) => pending.set(i, sweeps[i].next().then((r) => ({ i, r })));
  sweeps.forEach((_, i) => next(i));
  while (pending.size > 0) {
    const { i, r } = await Promise.race(pending.values());
    if (r.done) {
      pending.delete(i);
      continue;
    }
    next(i);
    yield r.value;
  }
}
