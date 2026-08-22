import type { EvoSDK } from '@dashevo/evo-sdk';

export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

/** The contested DPNS index every username contest lives under. */
export const DPNS_POLL = {
  dataContractId: DPNS_CONTRACT_ID,
  documentTypeName: 'domain',
  indexName: 'parentNameAndLabel',
} as const;

export interface ContestSummary {
  label: string;
  endsAtMs?: number;
}

export interface ContenderState {
  identityId: string;
  votes: number;
}

export interface ContestState {
  contenders: ContenderState[];
  abstain: number;
  lock: number;
  winner?: { kind: string; identityId?: string };
  totalVotes: number;
}

function labelFromResource(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    const last = entry[entry.length - 1];
    if (typeof last === 'string') return last;
  }
  return undefined;
}

/**
 * Poll index values come back as serialized platform Values: a 0x12 text tag,
 * a single length byte, then UTF-8 (labels are far below 128 bytes).
 * Exported for tests.
 */
export function decodeIndexValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  let bytes: Uint8Array | undefined;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    bytes = Uint8Array.from(raw as number[]);
  }
  if (!bytes || bytes.length < 2 || bytes[0] !== 0x12) return undefined;
  if (bytes[1] !== bytes.length - 2) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2));
  } catch {
    return undefined;
  }
}

const PAGE = 100;
const MAX_PAGES = 10;

async function fetchAllLabels(sdk: EvoSDK): Promise<string[]> {
  const labels: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resources = await sdk.group.contestedResources({
      ...DPNS_POLL,
      startIndexValues: ['dash'],
      limit: PAGE,
      ...(cursor !== undefined
        ? { startAtValue: cursor, startAtValueIncluded: false }
        : {}),
    });
    let last: string | undefined;
    for (const entry of resources) {
      const label = labelFromResource(entry);
      if (!label) continue;
      last = label;
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
    if (resources.length < PAGE || !last) break;
    cursor = last;
  }
  return labels;
}

async function fetchEndTimes(sdk: EvoSDK): Promise<Map<string, number>> {
  const endsAt = new Map<string, number>();
  let startTimeMs: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let buckets;
    try {
      buckets = await sdk.voting.votePollsByEndDate({
        limit: PAGE,
        ...(startTimeMs !== undefined
          ? { startTimeMs, startTimeIncluded: false }
          : {}),
      });
    } catch {
      break;
    }
    let lastTs: number | undefined;
    for (const bucket of buckets) {
      let ts: number;
      let polls: unknown[];
      try {
        ts = Number(bucket.timestampMs);
        polls = Array.from(bucket.votePolls ?? []);
      } catch {
        continue;
      }
      lastTs = ts;
      for (const poll of polls) {
        try {
          const p = poll as { documentTypeName?: string; indexValues?: unknown[] };
          const label = decodeIndexValue(Array.from(p.indexValues ?? [])[1]);
          if (p.documentTypeName === 'domain' && label) {
            endsAt.set(label, ts);
          }
        } catch {
          // Tolerate unexpected poll shapes; the end time is optional data.
        }
      }
    }
    if (buckets.length < PAGE || lastTs === undefined) break;
    startTimeMs = lastTs;
  }
  return endsAt;
}

let contestsCache: { at: number; promise: Promise<ContestSummary[]> } | null =
  null;

/** Active username contests with their scheduled end time where known. */
export function fetchContests(sdk: EvoSDK): Promise<ContestSummary[]> {
  if (contestsCache && Date.now() - contestsCache.at < 60_000) {
    return contestsCache.promise;
  }
  const promise = (async () => {
    const [labels, endsAt] = await Promise.all([
      fetchAllLabels(sdk),
      fetchEndTimes(sdk),
    ]);
    return labels.map((label) => ({ label, endsAtMs: endsAt.get(label) }));
  })();
  contestsCache = { at: Date.now(), promise };
  promise.catch(() => {
    contestsCache = null;
  });
  return promise;
}

/**
 * Tallies for one contest. Requested as `voteTally` only: contender documents
 * are serialized binary and have no business anywhere near the render path.
 */
export async function fetchContestState(
  sdk: EvoSDK,
  label: string,
): Promise<ContestState> {
  const state = await sdk.voting.contestedResourceVoteState({
    ...DPNS_POLL,
    indexValues: ['dash', label],
    resultType: 'voteTally',
    includeLockedAndAbstaining: true,
    limit: 100,
  });

  const contenders: ContenderState[] = [];
  for (const raw of Array.from(state.contenders ?? [])) {
    try {
      const c = raw as {
        identityId: { toBase58(): string };
        voteTally?: number;
      };
      contenders.push({
        identityId: c.identityId.toBase58(),
        votes: c.voteTally ?? 0,
      });
    } catch {
      // Skip contenders we cannot read rather than failing the page.
    }
  }
  contenders.sort((a, b) => b.votes - a.votes);

  const abstain = state.abstainVoteTally ?? 0;
  const lock = state.lockVoteTally ?? 0;

  let winner: ContestState['winner'];
  try {
    const w = state.winner;
    if (w) {
      winner = { kind: w.kind, identityId: w.identityId?.toBase58() };
    }
  } catch {
    // Unreadable winner info renders as an undecided contest.
  }

  return {
    contenders,
    abstain,
    lock,
    winner,
    totalVotes:
      contenders.reduce((sum, c) => sum + c.votes, 0) + abstain + lock,
  };
}

/** Voter identity IDs backing one contender (first page, newest-first order not guaranteed). */
export async function fetchVoters(
  sdk: EvoSDK,
  label: string,
  contenderId: string,
): Promise<string[]> {
  const voters = await sdk.group.contestedResourceVotersForIdentity({
    ...DPNS_POLL,
    indexValues: ['dash', label],
    contestantId: contenderId,
    limit: 100,
  });
  return voters.map((id) => id.toBase58());
}

const usernameCache = new Map<string, Promise<string[]>>();

/** Best-effort DPNS names already owned by an identity (for display only). */
export function fetchUsernames(sdk: EvoSDK, identityId: string): Promise<string[]> {
  let cached = usernameCache.get(identityId);
  if (!cached) {
    cached = sdk.dpns
      .usernames({ identityId, limit: 3 })
      .catch(() => [] as string[]);
    usernameCache.set(identityId, cached);
  }
  return cached;
}
