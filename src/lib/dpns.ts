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
  /** The name exactly as this contender requested it (e.g. "Theroadnottaken"). */
  requestedLabel?: string;
}

export interface ContestState {
  contenders: ContenderState[];
  abstain: number;
  lock: number;
  winner?: { kind: string; identityId?: string; decidedAtMs?: number };
  totalVotes: number;
  /** Requested form of the leading contender — preferred over the normalized label. */
  displayLabel?: string;
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
const CONTESTS_TTL_MS = 60_000;

/**
 * Streaming order: open contests soonest-closing first, then recently ended
 * newest first, then the archive of long-decided contests whose polls are
 * gone. Batches arrive already in display order.
 */
export type StreamPhase = 'open' | 'ended' | 'archive';
export interface ContestBatch {
  phase: StreamPhase;
  list: ContestSummary[];
}
export type StreamStatus = 'streaming' | 'done' | 'error';

interface StreamRun {
  at: number;
  batches: ContestBatch[];
  status: StreamStatus;
  batchListeners: Set<(batch: ContestBatch) => void>;
  statusListeners: Set<(status: StreamStatus) => void>;
}

let streamRun: StreamRun | null = null;

function startStream(sdk: EvoSDK): StreamRun {
  const run: StreamRun = {
    at: Date.now(),
    batches: [],
    status: 'streaming',
    batchListeners: new Set(),
    statusListeners: new Set(),
  };

  void (async () => {
    const seen = new Set<string>();
    let anySuccess = false;
    const push = (phase: StreamPhase, list: ContestSummary[]) => {
      if (list.length === 0) return;
      const batch = { phase, list };
      run.batches.push(batch);
      for (const listener of run.batchListeners) listener(batch);
    };

    // Polls are paged newest-end-date-first with offset pagination.
    // startTimeMs/endTimeMs are unusable in @dashevo/evo-sdk 4.1.1: integer
    // timestamps fail its Value deserializer ("expected f64") and fractional
    // ones fail its own integer check — a verified catch-22. Descending order
    // means page one carries every open contest plus the newest-ended ones,
    // so the rows that matter render after a single round trip.
    const nowMs = Date.now();
    const futures: ContestSummary[] = [];
    let openEmitted = false;
    const emitOpen = () => {
      openEmitted = true;
      // Descending gave furthest-future first; the open section wants
      // soonest-closing first.
      push('open', [...futures].reverse());
    };

    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      let buckets;
      try {
        buckets = await sdk.voting.votePollsByEndDate({
          orderAscending: false,
          limit: PAGE,
          ...(offset > 0 ? { offset } : {}),
        });
        anySuccess = true;
      } catch {
        break;
      }
      const pastBatch: ContestSummary[] = [];
      for (const bucket of buckets) {
        let ts: number;
        let polls: unknown[];
        try {
          ts = Number(bucket.timestampMs);
          polls = Array.from(bucket.votePolls ?? []);
        } catch {
          continue;
        }
        if (ts <= nowMs && !openEmitted) emitOpen();
        for (const poll of polls) {
          try {
            const p = poll as {
              documentTypeName?: string;
              indexValues?: unknown[];
            };
            const label = decodeIndexValue(Array.from(p.indexValues ?? [])[1]);
            if (p.documentTypeName !== 'domain' || !label || seen.has(label)) {
              continue;
            }
            seen.add(label);
            const summary = { label, endsAtMs: ts };
            if (ts > nowMs) futures.push(summary);
            else pastBatch.push(summary);
          } catch {
            // Tolerate unexpected poll shapes.
          }
        }
      }
      push('ended', pastBatch);
      if (buckets.length < PAGE) break;
      offset += PAGE;
    }
    if (!openEmitted) emitOpen();

    // Archive: contests whose polls are gone (decided long ago). Index order.
    let startCursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      let resources;
      try {
        resources = await sdk.group.contestedResources({
          ...DPNS_POLL,
          startIndexValues: ['dash'],
          limit: PAGE,
          ...(startCursor !== undefined
            ? { startAtValue: startCursor, startAtValueIncluded: false }
            : {}),
        });
        anySuccess = true;
      } catch {
        break;
      }
      const batch: ContestSummary[] = [];
      let last: string | undefined;
      for (const entry of resources) {
        const label = labelFromResource(entry);
        if (!label) continue;
        last = label;
        if (!seen.has(label)) {
          seen.add(label);
          batch.push({ label });
        }
      }
      push('archive', batch);
      if (resources.length < PAGE || !last) break;
      startCursor = last;
    }

    run.status = anySuccess ? 'done' : 'error';
    run.at = Date.now();
    for (const listener of run.statusListeners) listener(run.status);
    run.batchListeners.clear();
    run.statusListeners.clear();
  })();

  return run;
}

/**
 * Subscribe to the contest stream. Already-fetched batches replay
 * synchronously (instant back-navigation); new ones arrive as pages land.
 * Returns an unsubscribe function.
 */
export function subscribeContests(
  sdk: EvoSDK,
  onBatch: (batch: ContestBatch) => void,
  onStatus: (status: StreamStatus) => void,
): () => void {
  if (
    !streamRun ||
    (streamRun.status !== 'streaming' &&
      Date.now() - streamRun.at > CONTESTS_TTL_MS)
  ) {
    streamRun = startStream(sdk);
  }
  const run = streamRun;
  for (const batch of run.batches) onBatch(batch);
  onStatus(run.status);
  if (run.status !== 'streaming') return () => {};
  run.batchListeners.add(onBatch);
  run.statusListeners.add(onStatus);
  return () => {
    run.batchListeners.delete(onBatch);
    run.statusListeners.delete(onStatus);
  };
}

/** All contests, resolved once the stream completes. */
export function fetchContests(sdk: EvoSDK): Promise<ContestSummary[]> {
  return new Promise((resolve) => {
    const all: ContestSummary[] = [];
    subscribeContests(
      sdk,
      (batch) => all.push(...batch.list),
      (status) => {
        if (status !== 'streaming') resolve(all);
      },
    );
  });
}

const stateCache = new Map<
  string,
  { at: number; promise: Promise<ContestState>; value?: ContestState }
>();
const STATE_TTL_MS = 60_000;

/** Cached contest state, synchronously — lets a remounting list render instantly. */
export function peekContestState(label: string): ContestState | undefined {
  const hit = stateCache.get(label);
  return hit && Date.now() - hit.at < STATE_TTL_MS ? hit.value : undefined;
}

/**
 * Tallies for one contest, cached briefly so navigating between the list and
 * a contest page doesn't refetch the world. Requested as `voteTally` only:
 * contender documents are serialized binary and have no business anywhere
 * near the render path.
 */
export function fetchContestState(
  sdk: EvoSDK,
  label: string,
): Promise<ContestState> {
  const hit = stateCache.get(label);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.promise;
  const entry: { at: number; promise: Promise<ContestState>; value?: ContestState } = {
    at: Date.now(),
    promise: queryContestState(sdk, label),
  };
  stateCache.set(label, entry);
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      stateCache.delete(label);
    },
  );
  return entry.promise;
}

let dpnsContract: Promise<unknown> | null = null;

function fetchDpnsContract(sdk: EvoSDK): Promise<unknown> {
  if (!dpnsContract) {
    dpnsContract = sdk.contracts.fetch(DPNS_CONTRACT_ID);
    dpnsContract.catch(() => {
      dpnsContract = null;
    });
  }
  return dpnsContract;
}

async function queryContestState(
  sdk: EvoSDK,
  label: string,
): Promise<ContestState> {
  // Documents are requested alongside tallies so each contender's *requested*
  // spelling ("Theroadnottaken") can be shown instead of the normalized index
  // form ("ther0adn0ttaken"). The bytes are deserialized through the SDK —
  // never rendered raw.
  const [state, contract, mod] = await Promise.all([
    sdk.voting.contestedResourceVoteState({
      ...DPNS_POLL,
      indexValues: ['dash', label],
      resultType: 'documentsAndVoteTally',
      includeLockedAndAbstaining: true,
      limit: 100,
    }),
    fetchDpnsContract(sdk).catch(() => undefined),
    import('@dashevo/evo-sdk'),
  ]);
  const version = sdk.version();

  const contenders: ContenderState[] = [];
  for (const raw of Array.from(state.contenders ?? [])) {
    try {
      const c = raw as {
        identityId: { toBase58(): string };
        voteTally?: number;
        serializedDocument?: Uint8Array;
      };
      let requestedLabel: string | undefined;
      if (contract && c.serializedDocument) {
        try {
          const doc = mod.Document.fromBytes(
            c.serializedDocument,
            contract as Parameters<typeof mod.Document.fromBytes>[1],
            'domain',
            version,
          );
          const requested = (doc.toJSON(version) as { label?: unknown }).label;
          if (typeof requested === 'string') requestedLabel = requested;
        } catch {
          // Undecodable document: fall back to the normalized label.
        }
      }
      contenders.push({
        identityId: c.identityId.toBase58(),
        votes: c.voteTally ?? 0,
        requestedLabel,
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
      let decidedAtMs: number | undefined;
      try {
        const timeMs = Number(w.block?.timeMs);
        if (Number.isFinite(timeMs) && timeMs > 0) decidedAtMs = timeMs;
      } catch {
        // The deciding block is optional display data.
      }
      winner = { kind: w.kind, identityId: w.identityId?.toBase58(), decidedAtMs };
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
    displayLabel: contenders.find((c) => c.requestedLabel)?.requestedLabel,
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
