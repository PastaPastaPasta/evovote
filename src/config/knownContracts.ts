import type { Network } from '../sdk/network';

/**
 * Names for contracts the site knows, per network: labels only. Moderator
 * elections are titled by their target contract ("Moderators of Yappr
 * staging — posts"); a contract not listed here is named by its owner's
 * DPNS name or its short id, and described by its own description and what
 * it moderates. The moderated-contract directory (`#/m`) finds its contracts
 * on chain (charters/directory.ts); being listed here neither adds a
 * contract to it nor is needed to appear there.
 *
 * Testnet names Yappr's sites (yappr `staging` branch: `.env.testnet` is
 * /staging, `.env.beta` is /beta), Yappr's earlier rehearsal set (now
 * /staging-old) and EvoVote's own QA contracts (docs/V2_NOTES.md, "Live QA
 * on testnet").
 */
export interface KnownContract {
  /** Base58 contract id. */
  id: string;
  /** Display name, e.g. "Yappr staging — posts". */
  name: string;
  /** One line shown in the directory. */
  note?: string;
  /** False for a contract `#/m` never lists unless the user adds it (it holds no moderator election). */
  directory?: false;
}

export const KNOWN_CONTRACTS: Readonly<Record<Network, readonly KnownContract[]>> = {
  testnet: [
    {
      id: '4nYYMMs94m4asfQ2PdJ69uqugpfJ7PaQNjhJyHXSeLfb',
      name: 'Yappr staging — posts',
      note: "Posts, replies and profiles on Yappr's /staging site.",
    },
    {
      id: 'HTxaJC5hR9TZTCbY5D9JieEEYqGMmSW83uX7JE6akNre',
      name: 'Yappr staging — storefront',
      note: "Stores, listings and reviews on Yappr's /staging site.",
    },
    {
      id: 'FEqLoioCnW88QamdCvJgAoLqD1gFv871hqfvGbYZgp8r',
      name: 'Yappr staging — blogs',
      note: "Blogs, posts and comments on Yappr's /staging site.",
    },
    {
      id: '5Kucw9g9TsiSRXbns2mPumXKVkYW7jwVrTdjFuFhMEwU',
      name: 'Yappr beta — posts',
      note: "Posts, replies and profiles on Yappr's /beta site.",
    },
    {
      id: 'THxfq5ZinV2U5gmPZ8dTwqh11sCtGF53a2a87qHErNR',
      name: 'Yappr beta — storefront',
      note: "Stores, listings and reviews on Yappr's /beta site.",
    },
    {
      id: '9mMb6qGmPA8mjxkk7wdUE5aotEVpY1hJwPJZqPPdUdPc',
      name: 'Yappr beta — blogs',
      note: "Blogs, posts and comments on Yappr's /beta site.",
    },
    {
      id: 'AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9',
      name: 'Yappr staging-old (rehearsal) — posts',
      note: "Posts, replies and profiles on Yappr's earlier rehearsal, now /staging-old.",
    },
    {
      id: '9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS',
      name: 'Yappr staging-old (rehearsal) — storefront',
      note: "Stores, listings and reviews on Yappr's earlier rehearsal, now /staging-old.",
    },
    {
      id: 'HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa',
      name: 'Yappr staging-old (rehearsal) — blogs',
      note: "Blogs, posts and comments on Yappr's earlier rehearsal, now /staging-old.",
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
