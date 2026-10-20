import { ACTIVE_SOURCE, archiveSummaries, type ContestSource } from '../discovery/stream';
import type { PollKey } from '../model/pollKey';
import type { Network } from '../sdk/network';
import { charterKind } from './charter';
import { dpnsKind } from './dpns';
import { genericKind } from './generic';
import type { ContestKind, KindId } from './types';

/** Match order matters: specific kinds first, generic (matches all) last. */
export const KINDS: readonly ContestKind[] = [dpnsKind, charterKind, genericKind];

export function kindFor(key: PollKey): ContestKind {
  return KINDS.find((k) => k.matches(key)) ?? genericKind;
}

export function kindById(id: string): ContestKind | undefined {
  return KINDS.find((k) => k.id === id);
}

export function isKindId(id: string): id is KindId {
  return KINDS.some((k) => k.id === id);
}

/**
 * Kinds that exist on a network. The moderation charters contract is
 * testnet-only until mainnet runs protocol 14: reading its archive there
 * only earns a "contract not found" error.
 */
export function kindAvailable(kind: KindId, network: Network): boolean {
  return kind !== 'charter' || network === 'testnet';
}

export function kindsFor(network: Network): readonly ContestKind[] {
  return KINDS.filter((k) => kindAvailable(k.id, network));
}

/** One archive source per kind that has one. Stable objects: runs are shared by id. */
const ARCHIVE_SOURCES: ReadonlyMap<KindId, ContestSource> = new Map(
  KINDS.flatMap((k): [KindId, ContestSource][] => {
    const archive = k.archive;
    return archive
      ? [[k.id, { id: `${k.id} archive`, phase: 'archive', kindId: k.id, read: (sdk) => archiveSummaries(archive(sdk)) }]]
      : [];
  }),
);

/**
 * The sources a list reads: the active polls (every kind's open contests
 * come from there) plus the archive of each kind it shows, and nothing else.
 */
export function sourcesFor(network: Network, kind?: KindId): ContestSource[] {
  const kinds = kind ? [kind] : kindsFor(network).map((k) => k.id);
  return [
    ACTIVE_SOURCE,
    ...kinds.flatMap((k) => {
      const source = kindAvailable(k, network) ? ARCHIVE_SOURCES.get(k) : undefined;
      return source ? [source] : [];
    }),
  ];
}
