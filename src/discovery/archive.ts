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
 * Every resource ever contested on one contested index, in index order, via
 * `group.contestedResources` (it lives under `group`, not `voting`). This is
 * how decided contests are found once their poll left the end-date index.
 * Pages resume after the previous page's last value.
 */
export async function* sweepContestedResources(
  sdk: EvoSDK,
  sweep: ContestedResourceSweep,
  opts: { pageSize?: number; maxPages?: number } = {},
): AsyncGenerator<ArchivePage> {
  const pageSize = opts.pageSize ?? ARCHIVE_PAGE;
  const maxPages = opts.maxPages ?? ARCHIVE_MAX_PAGES;
  let cursor: unknown;
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
        ...(cursor !== undefined ? { startAtValue: cursor, startAtValueIncluded: false } : {}),
      });
    } catch (e) {
      yield { keys: [], failure: { source: sweep.source, message: errorMessage(e) } };
      return;
    }
    const keys: PollKey[] = [];
    for (const resource of resources) {
      const key = sweep.toKey(resource);
      if (key) keys.push(key);
    }
    seen += resources.length;
    yield { keys };
    if (resources.length < pageSize) return;
    cursor = resources[resources.length - 1];
  }
  yield { keys: [], cap: { source: sweep.source, limit: seen } };
}
