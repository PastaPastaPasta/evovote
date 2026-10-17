import type { Network } from '../sdk/network';
import { isContractIdLike } from './router';

const MAX_RECENT = 8;
const keyFor = (network: Network) => `evovote.recentContracts.${network}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Contract ids opened recently on `network`, newest first. Storage trouble reads as none. */
export function loadRecentContracts(network: Network, store: Store | undefined = defaultStore()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(keyFor(network)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && isContractIdLike(id)).slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

/** Put `contractId` first in the network's recent list. Failures to store are ignored. */
export function rememberContract(
  network: Network,
  contractId: string,
  store: Store | undefined = defaultStore(),
): string[] {
  const next = [contractId, ...loadRecentContracts(network, store).filter((id) => id !== contractId)].slice(
    0,
    MAX_RECENT,
  );
  try {
    store?.setItem(keyFor(network), JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the list simply is not kept.
  }
  return next;
}
