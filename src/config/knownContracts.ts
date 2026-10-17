import type { Network } from '../sdk/network';

/**
 * Contracts the site knows by name, per network. Moderator elections are
 * titled by their target contract ("Moderators of Yappr Social"); anything
 * not listed here falls back to its short id.
 *
 * Yappr's social, storefront and blog contracts declare elected moderation,
 * but their testnet release set is not registered yet (yappr
 * docs/TESTNET_RELEASE.md), so the lists are empty until it is. Add an entry
 * here once an id is final; the moderated-contract directory (`#/m`) lists
 * every entry of the current network.
 */
export interface KnownContract {
  /** Base58 contract id. */
  id: string;
  /** Display name, e.g. "Yappr Social". */
  name: string;
  /** One line shown in the directory. */
  note?: string;
}

export const KNOWN_CONTRACTS: Readonly<Record<Network, readonly KnownContract[]>> = {
  testnet: [],
  mainnet: [],
};

/** The known contracts of one network. */
export function knownContracts(network: Network): readonly KnownContract[] {
  return KNOWN_CONTRACTS[network];
}

/**
 * A known contract by id, on any network. Contract ids are hashes of their
 * owner and nonce, so one id never names two different contracts.
 */
export function knownContractById(id: string): KnownContract | undefined {
  for (const list of Object.values(KNOWN_CONTRACTS)) {
    const hit = list.find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}
