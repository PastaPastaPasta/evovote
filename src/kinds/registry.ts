import type { EvoSDK } from '@dashevo/evo-sdk';
import type { ArchiveSource } from '../discovery/stream';
import type { PollKey } from '../model/pollKey';
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

/** Archive sweeps for the stream. A stable array: the stream reuses runs by identity. */
export const ARCHIVE_SOURCES: readonly ArchiveSource[] = KINDS.flatMap((k) =>
  k.archive ? [{ kindId: k.id, archive: (sdk: EvoSDK) => k.archive!(sdk) }] : [],
);
