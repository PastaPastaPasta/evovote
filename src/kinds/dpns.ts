import type { EvoSDK } from '@dashevo/evo-sdk';
import { sweepContestedResources } from '../discovery/archive';
import { choicesForResolution, type Contest, type ContestSummary } from '../model/contest';
import { text } from '../model/indexValue';
import { encodePollKey, type PollKey } from '../model/pollKey';
import type { ContestKind } from './types';

/** The DPNS contract (same id on mainnet and testnet). */
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const DOCUMENT_TYPE = 'domain';
const INDEX_NAME = 'parentNameAndLabel';
const PARENT = 'dash';

/**
 * DPNS's homograph-safe form: lowercase, then o→0 and i/l→1. This is the
 * `normalizedLabel` the contested index is keyed by.
 */
export function normalizeDpnsLabel(label: string): string {
  return label.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
}

/** The poll key of a `.dash` username contest, from its normalized label. */
export function dpnsPollKey(label: string): PollKey {
  return {
    contractId: DPNS_CONTRACT_ID,
    documentTypeName: DOCUMENT_TYPE,
    indexName: INDEX_NAME,
    indexValues: [text(PARENT), text(label)],
  };
}

export function dpnsKeyString(label: string): string {
  return encodePollKey(dpnsPollKey(label));
}

/** The normalized label of a DPNS key, or undefined if it is not one. */
export function dpnsLabel(key: PollKey): string | undefined {
  if (
    key.contractId !== DPNS_CONTRACT_ID ||
    key.documentTypeName !== DOCUMENT_TYPE ||
    key.indexName !== INDEX_NAME ||
    key.indexValues.length !== 2
  ) {
    return undefined;
  }
  const [parent, label] = key.indexValues;
  if (parent.type !== 'text' || parent.value !== PARENT || label.type !== 'text') {
    return undefined;
  }
  return label.value;
}

/**
 * The name as contenders asked for it ("Theroadnottaken") rather than its
 * normalized index form ("ther0adn0ttaken"): the leading contender's
 * document `label`, when the vote state carried documents.
 */
export function dpnsDisplayLabel(c: ContestSummary | Contest): string {
  const normalized = dpnsLabel(c.key) ?? '';
  if (!('tally' in c)) return normalized;
  for (const contender of c.tally.contenders) {
    const requested = contender.document?.label;
    if (typeof requested === 'string' && requested) return requested;
  }
  return normalized;
}

const usernameCache = new Map<string, Promise<string[]>>();

/** Best-effort DPNS names already owned by an identity (display only). */
export function fetchUsernames(sdk: EvoSDK, identityId: string): Promise<string[]> {
  let cached = usernameCache.get(identityId);
  if (!cached) {
    cached = sdk.dpns.usernames({ identityId, limit: 3 }).catch(() => [] as string[]);
    usernameCache.set(identityId, cached);
  }
  return cached;
}

/** `.dash` usernames: homograph collisions and premium names (resolution 0). */
export const dpnsKind: ContestKind = {
  id: 'dpns',
  label: 'Usernames',
  matches: (key) => dpnsLabel(key) !== undefined,
  title: (c) => `${dpnsDisplayLabel(c)}.dash`,
  async describeContender(sdk, _c, contender) {
    const requested = contender.document?.label;
    const names = await fetchUsernames(sdk, contender.identityId);
    return {
      identityId: contender.identityId,
      title: typeof requested === 'string' ? requested : undefined,
      subtitle:
        names.length > 0 ? `also holds ${names.map((n) => `“${n}”`).join(', ')}` : undefined,
    };
  },
  // DPNS's contested index is resolution 0: contender, abstain or lock.
  choices: () => choicesForResolution(0),
  archive: (sdk) =>
    sweepContestedResources(sdk, {
      source: 'DPNS archive',
      contractId: DPNS_CONTRACT_ID,
      documentTypeName: DOCUMENT_TYPE,
      indexName: INDEX_NAME,
      prefix: [text(PARENT)],
      toKey: (resource) => {
        // Resources come back as the label string (verified on rc.4 testnet).
        const label = Array.isArray(resource) ? resource[resource.length - 1] : resource;
        return typeof label === 'string' ? dpnsPollKey(label) : undefined;
      },
    }),
};
