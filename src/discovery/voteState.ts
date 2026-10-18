import type { EvoSDK } from '@dashevo/evo-sdk';
import type { Contender, Contest, ContestSummary, Resolution, Winner } from '../model/contest';
import { toQueryValue } from '../model/indexValue';
import { freeQuietly } from '../sdk/free';
import type { PollKey } from '../model/pollKey';
import { fetchContestedIndex, fetchContract } from './contracts';

/** The structural shape of a vote-state result this module reads. */
export interface RawVoteState {
  contenders?: unknown[];
  abstainVoteTally?: number;
  lockVoteTally?: number;
  winner?: {
    kind: string;
    identityId?: { toBase58(): string } | string;
    block?: { timeMs?: bigint | number };
  };
}

interface RawContender {
  identityId: { toBase58(): string } | string;
  voteTally?: number;
  serializedDocument?: Uint8Array;
  free?: () => void;
}

const idString = (id: { toBase58(): string } | string): string =>
  typeof id === 'string' ? id : id.toBase58();

/** The query fields that address a poll. */
export function pollQuery(key: PollKey) {
  return {
    dataContractId: key.contractId,
    documentTypeName: key.documentTypeName,
    indexName: key.indexName,
    indexValues: key.indexValues.map(toQueryValue),
  };
}

/**
 * Map a vote-state result to a Contest. Pure (the document decoder is
 * injected); exported for tests. Contenders that cannot be read are skipped
 * and counted rather than failing the whole contest.
 */
export function toContest(
  summary: ContestSummary,
  state: RawVoteState,
  opts: {
    resolution?: Resolution;
    decodeDocument?: (bytes: Uint8Array) => Record<string, unknown> | undefined;
  } = {},
): Contest {
  const contenders: Contender[] = [];
  let unreadableContenders = 0;
  for (const raw of Array.from(state.contenders ?? [])) {
    const c = raw as RawContender;
    try {
      let document: Record<string, unknown> | undefined;
      if (c.serializedDocument && opts.decodeDocument) {
        try {
          document = opts.decodeDocument(c.serializedDocument);
        } catch {
          // Undecodable document: the contender still counts.
        }
      }
      contenders.push({ identityId: idString(c.identityId), votes: c.voteTally ?? 0, document });
    } catch {
      unreadableContenders++;
    } finally {
      freeQuietly(c);
    }
  }
  contenders.sort((a, b) => b.votes - a.votes);
  const abstain = state.abstainVoteTally ?? 0;
  const lock = state.lockVoteTally ?? 0;

  let winner: Winner | undefined;
  try {
    const w = state.winner;
    if (w) {
      let decidedAtMs: number | undefined;
      try {
        const timeMs = Number(w.block?.timeMs);
        if (Number.isFinite(timeMs) && timeMs > 0) decidedAtMs = timeMs;
      } catch {
        // The deciding block is optional display data.
      }
      const identityId = w.identityId ? idString(w.identityId) : undefined;
      const kind: Winner['kind'] = identityId
        ? 'identity'
        : w.kind.toLowerCase().includes('lock')
          ? 'locked'
          : 'other';
      winner = { kind, identityId, rawKind: w.kind, decidedAtMs };
    }
  } catch {
    // An unreadable winner renders as undecided; the tally is still right.
  }

  return {
    ...summary,
    tally: {
      contenders,
      abstain,
      lock,
      total: contenders.reduce((sum, c) => sum + c.votes, 0) + abstain + lock,
    },
    winner,
    resolution: opts.resolution,
    unreadableContenders,
  };
}

async function queryContest(sdk: EvoSDK, summary: ContestSummary): Promise<Contest> {
  const { key } = summary;
  // Documents come with the tallies so adapters can show what each contender
  // asked for (DPNS: the requested spelling). Bytes are decoded through the
  // SDK against the contract, never rendered raw.
  const [state, contract, index, mod] = await Promise.all([
    sdk.voting.contestedResourceVoteState({
      ...pollQuery(key),
      resultType: 'documentsAndVoteTally',
      includeLockedAndAbstaining: true,
      limit: 100,
    }),
    fetchContract(sdk, key.contractId).catch(() => undefined),
    fetchContestedIndex(sdk, key.contractId, key.documentTypeName, key.indexName).catch(
      () => undefined,
    ),
    import('@dashevo/evo-sdk'),
  ]);
  const version = sdk.version();
  try {
    return toContest(summary, state as unknown as RawVoteState, {
      resolution: index?.resolution,
      decodeDocument: contract
        ? (bytes) => {
            const doc = mod.Document.fromBytes(bytes, contract, key.documentTypeName, version);
            try {
              return doc.toJSON(version) as Record<string, unknown>;
            } finally {
              freeQuietly(doc);
            }
          }
        : undefined,
    });
  } finally {
    freeQuietly(state);
  }
}

const STATE_TTL_MS = 60_000;
const stateCache = new Map<string, { at: number; promise: Promise<Contest>; value?: Contest }>();

/** A cached contest, synchronously: lets a remounting list render instantly. */
export function peekContest(keyString: string): Contest | undefined {
  const hit = stateCache.get(keyString);
  return hit && Date.now() - hit.at < STATE_TTL_MS ? hit.value : undefined;
}

/**
 * A contest's vote state, cached briefly so moving between the list and a
 * contest page does not refetch the world. Failed reads are not cached.
 */
export function fetchContest(
  sdk: EvoSDK,
  summary: ContestSummary,
  force = false,
): Promise<Contest> {
  const hit = stateCache.get(summary.keyString);
  if (!force && hit && Date.now() - hit.at < STATE_TTL_MS) {
    // The caller's summary may know an end time the cached one lacked.
    return hit.promise.then((c) => ({ ...c, endsAtMs: summary.endsAtMs ?? c.endsAtMs }));
  }
  const entry: { at: number; promise: Promise<Contest>; value?: Contest } = {
    at: Date.now(),
    promise: queryContest(sdk, summary),
  };
  stateCache.set(summary.keyString, entry);
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (stateCache.get(summary.keyString) === entry) stateCache.delete(summary.keyString);
    },
  );
  return entry.promise;
}

/** Drop a cached contest (after voting, so the next read is fresh). */
export function invalidateContest(keyString: string): void {
  stateCache.delete(keyString);
}

/**
 * The masternodes voting for one contender (first page). Platform keys these
 * votes by the masternode's ProTxHash, so the identifiers are ProTxHashes,
 * returned here as the hex Core shows.
 */
export async function fetchVoters(
  sdk: EvoSDK,
  key: PollKey,
  contenderId: string,
  limit = 100,
): Promise<string[]> {
  const voters = await sdk.group.contestedResourceVotersForIdentity({
    ...pollQuery(key),
    contestantId: contenderId,
    limit,
  });
  return voters.map((id) => {
    try {
      return id.toHex();
    } finally {
      freeQuietly(id);
    }
  });
}
