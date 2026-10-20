import type { EvoSDK } from '@dashevo/evo-sdk';
import { mergeSweeps, sweepContestedResources, type ContestedResourceSweep } from '../discovery/archive';
import { chunk } from '../discovery/concurrency';
import { freeQuietly } from '../sdk/free';
import type { Network } from '../sdk/network';
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

/** A name without its ".dash" suffix (any case). */
export function stripDash(name: string): string {
  return name.replace(/\.dash$/i, '');
}

/** A username ("Bob.dash", "bob") in its normalized form ("b0b"). */
export function normalizedUsername(name: string): string {
  return normalizeDpnsLabel(stripDash(name));
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
 * How long a contested username vote runs (Platform's vote poll duration):
 * two weeks on mainnet, 90 minutes on testnet. Only used to line names up
 * by decision date; displayed dates come from the deciding block.
 */
export const DPNS_VOTE_PERIOD_MS: Readonly<Record<Network, number>> = {
  mainnet: 14 * 24 * 3_600_000,
  testnet: 90 * 60_000,
};

/** A registered `.dash` name, as its domain document has it. */
export interface DpnsName {
  /** The spelling the owner registered, e.g. "Alice". */
  label: string;
  ownerId?: string;
  /** When the document was created (for a contested name: when its owner asked for it). */
  createdAtMs?: number;
}

// Registered spellings by normalized label, learned from name documents.
// A registered name's label never changes, so this only grows.
const spellings = new Map<string, string>();

/** Record a registered spelling so every title of that name can show it. */
export function rememberDpnsSpelling(normalized: string, label: string): void {
  if (normalizeDpnsLabel(label) === normalized) spellings.set(normalized, label);
}

/**
 * The name as contenders asked for it ("Theroadnottaken") rather than its
 * normalized index form ("ther0adn0ttaken"): the leading contender's
 * document `label` when the vote state carried documents, else the
 * registered spelling if it is known (decided contests carry no documents).
 */
export function dpnsDisplayLabel(c: ContestSummary | Contest): string {
  return dpnsSpelling(c).label;
}

/** dpnsDisplayLabel, plus whether it is a real spelling (false: only the normalized form is known). */
export function dpnsSpelling(c: ContestSummary | Contest): { label: string; known: boolean } {
  const normalized = dpnsLabel(c.key) ?? '';
  if ('tally' in c) {
    for (const contender of c.tally.contenders) {
      const requested = contender.document?.label;
      if (typeof requested === 'string' && requested) return { label: requested, known: true };
    }
  }
  const registered = spellings.get(normalized);
  return registered ? { label: registered, known: true } : { label: normalized, known: false };
}

/** Most values an `in` clause takes (and most documents a page returns). */
export const NAME_BATCH = 100;

/** Pure mapping of a domain document's JSON; exported for tests. */
export function toDpnsName(json: Record<string, unknown>): DpnsName | undefined {
  const label = json.label;
  if (typeof label !== 'string' || !label) return undefined;
  const owner = json.$ownerId;
  const created = Number(json.$createdAt);
  return {
    label,
    ownerId: typeof owner === 'string' ? owner : undefined,
    createdAtMs: Number.isFinite(created) && created > 0 ? created : undefined,
  };
}

/**
 * The registered `.dash` names for some normalized labels, by normalized
 * label, in batches of 100 (`normalizedLabel in [...]`). A label with no
 * document (locked, or still being voted on) is simply absent. Throws when a
 * batch cannot be read.
 */
export async function fetchDpnsNames(
  sdk: EvoSDK,
  labels: readonly string[],
): Promise<Map<string, DpnsName>> {
  const out = new Map<string, DpnsName>();
  const version = sdk.version();
  for (const batch of chunk(labels, NAME_BATCH)) {
    const docs = await sdk.documents.query({
      dataContractId: DPNS_CONTRACT_ID,
      documentTypeName: DOCUMENT_TYPE,
      where: [
        ['normalizedParentDomainName', '==', PARENT],
        ['normalizedLabel', 'in', batch],
      ],
      orderBy: [['normalizedLabel', 'asc']],
      limit: NAME_BATCH,
    });
    const found = [...docs.values()];
    try {
      for (const doc of found) {
        if (!doc) continue;
        try {
          const json = doc.toJSON(version) as Record<string, unknown>;
          const name = toDpnsName(json);
          const normalized = json.normalizedLabel;
          if (name && typeof normalized === 'string') {
            out.set(normalized, name);
            rememberDpnsSpelling(normalized, name.label);
          }
        } catch {
          // One unreadable document costs only its own name.
        }
      }
    } finally {
      found.forEach(freeQuietly);
    }
  }
  return out;
}

/**
 * Where the archive is cut into slices swept in parallel (first characters
 * of the normalized label; DPNS labels start with [a-z0-9] and normalized
 * ones have no i, l or o). Eleven sequential pages of testnet's ~1,000
 * contested names become two or three per slice.
 */
const ARCHIVE_SLICES = ['b', 'e', 'm', 'n', 't', 'u'];

/**
 * The label of a returned archive resource: the label string itself
 * (verified on rc.4 testnet), or the last value if it comes as an array.
 */
export function labelOf(resource: unknown): string | undefined {
  const label = Array.isArray(resource) ? resource[resource.length - 1] : resource;
  return typeof label === 'string' ? label : undefined;
}

const ARCHIVE_SWEEP: ContestedResourceSweep = {
  source: 'DPNS archive',
  contractId: DPNS_CONTRACT_ID,
  documentTypeName: DOCUMENT_TYPE,
  indexName: INDEX_NAME,
  prefix: [text(PARENT)],
  toKey: (resource) => {
    const label = labelOf(resource);
    return label === undefined ? undefined : dpnsPollKey(label);
  },
};

/** Index-order slices [from, to) covering every label. */
export function archiveSlices(cuts: readonly string[] = ARCHIVE_SLICES): Array<{ from?: string; to?: string }> {
  const bounds = [undefined, ...cuts, undefined];
  return bounds.slice(0, -1).map((from, i) => ({ from, to: bounds[i + 1] }));
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
    mergeSweeps(
      archiveSlices().map(({ from, to }) =>
        sweepContestedResources(sdk, ARCHIVE_SWEEP, {
          range: {
            from,
            stop: to === undefined ? undefined : (r) => (labelOf(r) ?? '') >= to,
          },
        }),
      ),
    ),
};
