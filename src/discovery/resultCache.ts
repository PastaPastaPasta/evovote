import type { DpnsName } from '../kinds/dpns';
import type { Contest, Resolution, Tally, Winner } from '../model/contest';
import { decodePollKey } from '../model/pollKey';
import type { Network } from '../sdk/network';

/**
 * Decided contests never change, so their results are kept in IndexedDB
 * (per network, by contest key, no expiry) and a returning visitor sees
 * them at once instead of re-reading a thousand tallies. Open and undecided
 * contests are never stored. The registered spelling of a decided username
 * is kept alongside. Everything here fails soft: without IndexedDB (private
 * mode, tests) the cache is simply empty.
 */

export interface CachedResult {
  /** `${network}|${keyString}` */
  id: string;
  network: Network;
  keyString: string;
  /** The decided outcome, without contender documents. */
  result?: { tally: Tally; winner: Winner; resolution?: Resolution };
  /** For a username: its registered name document. */
  name?: DpnsName;
}

export interface CachedDirectory {
  results: Map<string, CachedResult>;
  /** Kinds whose whole archive was read and ordered once. */
  complete: Set<string>;
}

const DB_NAME = 'evovote-directory';
const RESULTS = 'results';
const META = 'meta';

/**
 * How long the first read waits for IndexedDB to open. Some WebKit builds
 * never answer `indexedDB.open` at all; the page then starts without a
 * cache (and still writes to it if the open answers late).
 */
export const OPEN_TIMEOUT_MS = 4_000;

let db: Promise<IDBDatabase | undefined> | undefined;

function openDb(): Promise<IDBDatabase | undefined> {
  db ??= new Promise((settle) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      settle(undefined);
    }, OPEN_TIMEOUT_MS);
    const resolve = (handle: IDBDatabase | undefined) => {
      clearTimeout(timer);
      // A slow open that answers after all: later writes use it.
      if (timedOut && handle) db = Promise.resolve(handle);
      settle(handle);
    };
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(RESULTS, { keyPath: 'id' });
        req.result.createObjectStore(META, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return db;
}

function getAll<T>(store: IDBObjectStore, network: Network): Promise<T[]> {
  return new Promise((resolve) => {
    const req = store.getAll(IDBKeyRange.bound(`${network}|`, `${network}|￿`));
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => resolve([]);
  });
}

const loaded = new Map<Network, Promise<CachedDirectory>>();
const ready = new Map<Network, CachedDirectory>();

/** The cached directory of a network, read once per page load. */
export function loadCachedDirectory(network: Network): Promise<CachedDirectory> {
  let hit = loaded.get(network);
  if (!hit) {
    hit = (async () => {
      const out: CachedDirectory = { results: new Map(), complete: new Set() };
      const handle = await openDb();
      if (handle) {
        try {
          const tx = handle.transaction([RESULTS, META], 'readonly');
          const [results, meta] = await Promise.all([
            getAll<CachedResult>(tx.objectStore(RESULTS), network),
            getAll<{ id: string; kindId: string }>(tx.objectStore(META), network),
          ]);
          for (const r of results) out.results.set(r.keyString, r);
          for (const m of meta) out.complete.add(m.kindId);
        } catch {
          // An unreadable cache is an empty one.
        }
      }
      ready.set(network, out);
      return out;
    })();
    loaded.set(network, hit);
  }
  return hit;
}

/** The cached directory if it has finished loading (lets a remount render at once). */
export function peekCachedDirectory(network: Network): CachedDirectory | undefined {
  return ready.get(network);
}

let pendingRecords: CachedResult[] = [];
let pendingMeta: { id: string; kindId: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    const records = pendingRecords;
    const meta = pendingMeta;
    pendingRecords = [];
    pendingMeta = [];
    void openDb().then((handle) => {
      if (!handle) return;
      try {
        const tx = handle.transaction([RESULTS, META], 'readwrite');
        for (const r of records) tx.objectStore(RESULTS).put(r);
        for (const m of meta) tx.objectStore(META).put(m);
      } catch {
        // A failed write only costs a re-read next visit.
      }
    });
  }, 500);
}

/** Merge new facts about a contest into its cached record (in memory and, soon, on disk). */
export function saveCachedResult(
  network: Network,
  keyString: string,
  patch: Pick<CachedResult, 'result' | 'name'>,
): void {
  const dir = ready.get(network);
  if (!dir) {
    // Merge into what is stored, never over it.
    void loadCachedDirectory(network).then(() => saveCachedResult(network, keyString, patch));
    return;
  }
  const record: CachedResult = {
    ...dir.results.get(keyString),
    ...patch,
    id: `${network}|${keyString}`,
    network,
    keyString,
  };
  dir.results.set(keyString, record);
  pendingRecords.push(record);
  scheduleFlush();
}

/** Remember that a kind's whole archive has been read and ordered once. */
export function markDirectoryComplete(network: Network, kindId: string): void {
  const dir = ready.get(network);
  if (!dir) {
    void loadCachedDirectory(network).then(() => markDirectoryComplete(network, kindId));
    return;
  }
  if (dir.complete.has(kindId)) return;
  dir.complete.add(kindId);
  pendingMeta.push({ id: `${network}|${kindId}`, kindId });
  scheduleFlush();
}

/** A contest worth storing: decided, with every contender read. */
export function isStorable(c: Contest): c is Contest & { winner: Winner } {
  return c.winner !== undefined && c.unreadableContenders === 0;
}

/** A stored result as a Contest (no documents), or undefined if its key no longer decodes. */
export function cachedContest(record: CachedResult): Contest | undefined {
  if (!record.result) return undefined;
  const key = decodePollKey(record.keyString);
  if (!key) return undefined;
  return {
    key,
    keyString: record.keyString,
    tally: record.result.tally,
    winner: record.result.winner,
    resolution: record.result.resolution,
    unreadableContenders: 0,
  };
}

/** The storable part of a decided contest: documents are dropped. */
export function resultOf(c: Contest & { winner: Winner }): NonNullable<CachedResult['result']> {
  return {
    tally: {
      ...c.tally,
      contenders: c.tally.contenders.map(({ identityId, votes }) => ({ identityId, votes })),
    },
    winner: c.winner,
    resolution: c.resolution,
  };
}
