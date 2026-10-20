import type { Network } from '../sdk/network';

/**
 * Contracts the site knows by name, per network. Moderator elections are
 * titled by their target contract ("Moderators of Yappr Social"); anything
 * not listed here falls back to what its declaration says it moderates.
 *
 * Testnet lists the contracts its elections are actually held for today:
 * Yappr's public staging rehearsal (yappr `.env.staging` on `staging`,
 * storage epoch testnet-staging-20261018) and EvoVote's own QA contracts
 * (docs/V2_NOTES.md, "Live QA on testnet"). Yappr's production testnet set
 * is registered separately; add it here once its ids are final. The
 * moderated-contract directory (`#/m`) lists every entry of the current
 * network that has a moderator election.
 */
export interface KnownContract {
  /** Base58 contract id. */
  id: string;
  /** Display name, e.g. "Yappr Social". */
  name: string;
  /** One line shown in the directory. */
  note?: string;
  /** False for a contract with no moderator election: named, but not listed in `#/m`. */
  directory?: false;
}

export const KNOWN_CONTRACTS: Readonly<Record<Network, readonly KnownContract[]>> = {
  testnet: [
    {
      id: 'AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9',
      name: 'Yappr (testnet staging) — posts',
      note: "Posts, replies and profiles on Yappr's staging rehearsal.",
    },
    {
      id: '9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS',
      name: 'Yappr (testnet staging) — storefront',
      note: "Stores, listings and reviews on Yappr's staging rehearsal.",
    },
    {
      id: 'HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa',
      name: 'Yappr (testnet staging) — blogs',
      note: "Blogs, posts and comments on Yappr's staging rehearsal.",
    },
    {
      id: 'EFyPZPsEDLHtN1R38CgzeAGfWr23DrgthPpTgbCW8zAt',
      name: 'EvoVote QA election',
      note: "A throwaway contract EvoVote's testnet QA held a full election on.",
    },
    {
      id: '2iaUXM8bZb6paYW1mRWCEUMe8EU1tp4Tbg456PXPN3qt',
      name: 'EvoVote discussions',
      note: 'The comment threads under every contest.',
      directory: false,
    },
  ],
  mainnet: [],
};

/** The known contracts of one network that the moderated-contract directory lists. */
export function knownContracts(network: Network): readonly KnownContract[] {
  return KNOWN_CONTRACTS[network].filter((c) => c.directory !== false);
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
