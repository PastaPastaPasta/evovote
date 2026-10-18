import type { EvoSDK } from '@dashevo/evo-sdk';
import { forEachConcurrent } from '../discovery/concurrency';
import { fetchUsernames } from '../kinds/dpns';

/** Lookups in flight at once (each is its own DAPI request). */
const LOOKUPS_AT_ONCE = 6;

/**
 * First DPNS name of each identity, for a page of comments. The ids are
 * de-duplicated (an author usually has many comments) and looked up with
 * bounded concurrency; `fetchUsernames` caches per identity across pages.
 * An identity with no name, or a failed lookup, is simply absent.
 */
export async function resolveNames(sdk: EvoSDK, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  await forEachConcurrent(unique, LOOKUPS_AT_ONCE, async (id) => {
    const [name] = await fetchUsernames(sdk, id);
    if (name) names.set(id, name);
  });
  return names;
}
