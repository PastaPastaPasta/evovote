import type { EvoSDK } from '@dashevo/evo-sdk';
import type { Contest, ContestSummary } from '../model/contest';
import { indexValueFromJs, type IndexValue } from '../model/indexValue';
import { encodePollKey, type PollKey } from '../model/pollKey';
import { errorMessage } from '../sdk/errors';
import { getActivePolls } from './activePolls';
import { sweepContestedResources, type ArchivePage } from './archive';
import { createPump } from './concurrency';
import {
  contestedIndices,
  contractJson,
  documentSchema,
  documentTypeNames,
  fetchContract,
  type ContestedIndex,
} from './contracts';
import type { Cap, Failure } from './types';
import { fetchContest } from './voteState';

/** Contested values listed per index before the browser stops and says so. */
export const BROWSE_MAX_CONTESTS = 100;
/** Vote-state reads in flight at once. */
export const BROWSE_TALLY_CONCURRENCY = 5;

// ---- typing the values a sweep returns ------------------------------------------

const SYSTEM_INTEGER_FIELDS = new Set([
  '$createdAt',
  '$updatedAt',
  '$transferredAt',
  '$createdAtBlockHeight',
  '$updatedAtBlockHeight',
  '$transferredAtBlockHeight',
  '$createdAtCoreBlockHeight',
  '$updatedAtCoreBlockHeight',
  '$transferredAtCoreBlockHeight',
]);

interface PropertySchema {
  type?: unknown;
  byteArray?: unknown;
  contentMediaType?: unknown;
}

/** The JSON schema of an index property; dotted paths walk nested objects. */
function propertySchema(docSchema: unknown, path: string): PropertySchema | undefined {
  let node = docSchema as { properties?: Record<string, unknown> } | undefined;
  let found: unknown;
  for (const part of path.split('.')) {
    found = node?.properties?.[part];
    node = found as typeof node;
  }
  return found as PropertySchema | undefined;
}

/**
 * Type one value `contestedResources` returned for an index property. The
 * node returns plain JS values, so the contract's schema decides whether a
 * string is an identifier: a poll key has to carry the type the chain has,
 * because the typed value is what a poll id is hashed from.
 */
export function indexValueForProperty(
  raw: unknown,
  property: string,
  docSchema: unknown,
): IndexValue | undefined {
  const schema = propertySchema(docSchema, property);
  const identifierField =
    property === '$ownerId' ||
    property === '$id' ||
    (schema?.byteArray === true &&
      schema.contentMediaType === 'application/x.dash.dpp.identifier');
  if (identifierField) {
    const asString =
      typeof raw === 'object' && raw !== null && 'toBase58' in raw
        ? (raw as { toBase58(): string }).toBase58()
        : raw;
    return indexValueFromJs(asString, 'identifier');
  }
  if (SYSTEM_INTEGER_FIELDS.has(property) || schema?.type === 'integer') {
    return typeof raw === 'bigint' || (typeof raw === 'number' && Number.isInteger(raw))
      ? { type: 'integer', value: BigInt(raw) }
      : undefined;
  }
  return indexValueFromJs(raw);
}

// ---- sweeping one contested index -----------------------------------------------

export interface IndexSweepOptions {
  pageSize?: number;
  maxPages?: number;
  /** Values listed before the sweep stops and reports a cap. */
  maxContests?: number;
  signal?: AbortSignal;
}

/**
 * Every contested value of one index. `contestedResources` returns the next
 * index property after a prefix of values, so an index over n properties is
 * walked as a tree: each non-leaf value is expanded with itself as the
 * prefix, and the leaf level yields the poll keys. Pages carry the failure or
 * cap that ended a branch; the walk never turns a failed read into "none".
 */
export async function* sweepContestedIndex(
  sdk: EvoSDK,
  contractId: string,
  index: ContestedIndex,
  docSchema: unknown,
  opts: IndexSweepOptions = {},
): AsyncGenerator<ArchivePage> {
  const source = `${index.documentTypeName} · ${index.indexName}`;
  const max = opts.maxContests ?? BROWSE_MAX_CONTESTS;
  const depth = index.properties.length;
  if (depth === 0) {
    yield { keys: [], failure: { source, message: 'the index declares no properties' } };
    return;
  }
  let emitted = 0;
  let stopped = false;

  async function* walk(prefix: IndexValue[]): AsyncGenerator<ArchivePage> {
    const leaf = prefix.length === depth - 1;
    const property = index.properties[prefix.length];
    const branches: IndexValue[] = [];
    const sweep = sweepContestedResources(
      sdk,
      {
        source,
        contractId,
        documentTypeName: index.documentTypeName,
        indexName: index.indexName,
        prefix,
        toKey: (resource) => {
          const value = indexValueForProperty(resource, property, docSchema);
          if (!value) return undefined;
          if (!leaf) {
            branches.push(value);
            return undefined;
          }
          return {
            contractId,
            documentTypeName: index.documentTypeName,
            indexName: index.indexName,
            indexValues: [...prefix, value],
          };
        },
      },
      { pageSize: opts.pageSize, maxPages: opts.maxPages },
    );
    for await (const page of sweep) {
      if (opts.signal?.aborted) {
        stopped = true;
        return;
      }
      const room = max - emitted;
      if (page.keys.length > room) {
        // One value past the limit proves there are more than are listed.
        yield { keys: page.keys.slice(0, room) };
        yield { keys: [], cap: { source, limit: max } };
        emitted = max;
        stopped = true;
        return;
      }
      emitted += page.keys.length;
      yield page;
    }
    for (const value of branches) {
      if (stopped) return;
      yield* walk([...prefix, value]);
    }
  }

  yield* walk([]);
}

// ---- assembling the contract browser --------------------------------------------

export interface BrowsedContest {
  summary: ContestSummary;
  /** The vote state once read; 'error' when the read failed. */
  state: Contest | 'loading' | 'error';
}

export interface BrowsedType {
  index: ContestedIndex;
  contests: BrowsedContest[];
  /** True until this index's sweep has ended (completed, capped or failed). */
  sweeping: boolean;
}

export interface ContractView {
  contractId: string;
  /** not-found: the contract does not exist on this network. */
  load: 'loading' | 'ready' | 'not-found' | 'error';
  /** Every document type in the contract, so "none contested" can be said plainly. */
  documentTypes: string[];
  /** Only document types with a contested index. */
  types: BrowsedType[];
  failures: Failure[];
  caps: Cap[];
}

export interface BrowseOptions extends IndexSweepOptions {
  tallyConcurrency?: number;
  onUpdate?: (view: ContractView) => void;
  /** Injected in tests; defaults to the cached WP1 vote-state read. */
  readContest?: (sdk: EvoSDK, summary: ContestSummary) => Promise<Contest>;
  /** Injected in tests; defaults to the shared active-poll walk. */
  readActive?: (sdk: EvoSDK) => Promise<{ polls: ContestSummary[]; failures: Failure[] }>;
}

/**
 * Everything the contract browser shows for `#/c/<contractId>`: the
 * contract's contested indices, each swept for its contested values, each
 * value's vote state read with bounded concurrency. `onUpdate` receives a
 * fresh snapshot after every step so a page can render progressively; the
 * returned promise resolves with the final view once everything settled.
 */
export async function browseContract(
  sdk: EvoSDK,
  contractId: string,
  opts: BrowseOptions = {},
): Promise<ContractView> {
  const view: ContractView = {
    contractId,
    load: 'loading',
    documentTypes: [],
    types: [],
    failures: [],
    caps: [],
  };
  const emit = () =>
    opts.onUpdate?.({
      ...view,
      types: view.types.map((t) => ({ ...t, contests: t.contests.map((c) => ({ ...c })) })),
      failures: [...view.failures],
      caps: [...view.caps],
    });
  const aborted = () => opts.signal?.aborted === true;
  emit();

  let json: unknown;
  try {
    const contract = await fetchContract(sdk, contractId);
    if (!contract) {
      view.load = 'not-found';
      emit();
      return view;
    }
    json = contractJson(sdk, contract);
  } catch (e) {
    view.load = 'error';
    view.failures.push({ source: 'the contract', message: errorMessage(e) });
    emit();
    return view;
  }

  view.documentTypes = documentTypeNames(json);
  view.types = contestedIndices(json).map((index) => ({ index, contests: [], sweeping: true }));
  view.load = 'ready';
  emit();
  if (view.types.length === 0 || aborted()) return view;

  // End times come from the end-date index; reading it also keeps the chain's
  // own poll objects, which are what a vote on a non-text index is signed over.
  const endsAt = new Map<string, number>();
  try {
    const active = await (opts.readActive ?? getActivePolls)(sdk);
    for (const poll of active.polls) {
      if (poll.endsAtMs !== undefined) endsAt.set(poll.keyString, poll.endsAtMs);
    }
    view.failures.push(...active.failures);
  } catch (e) {
    view.failures.push({ source: 'active polls', message: errorMessage(e) });
  }

  const read = opts.readContest ?? fetchContest;
  const pump = createPump<{ entry: BrowsedContest; done: () => void }>(
    opts.tallyConcurrency ?? BROWSE_TALLY_CONCURRENCY,
    async ({ entry, done }) => {
      try {
        if (aborted()) return;
        const state = await read(sdk, entry.summary);
        entry.state = state;
      } catch {
        entry.state = 'error';
      } finally {
        done();
        if (!aborted()) emit();
      }
    },
  );
  const settled: Promise<void>[] = [];

  for (const type of view.types) {
    if (aborted()) break;
    const docSchema = documentSchema(json, type.index.documentTypeName);
    try {
      for await (const page of sweepContestedIndex(sdk, contractId, type.index, docSchema, opts)) {
        if (aborted()) break;
        if (page.failure) view.failures.push(page.failure);
        if (page.cap) view.caps.push(page.cap);
        const fresh: BrowsedContest[] = page.keys.map((key: PollKey) => {
          const keyString = encodePollKey(key);
          return { summary: { key, keyString, endsAtMs: endsAt.get(keyString) }, state: 'loading' };
        });
        type.contests.push(...fresh);
        for (const entry of fresh) {
          settled.push(new Promise<void>((done) => pump.push([{ entry, done }])));
        }
        emit();
      }
    } catch (e) {
      view.failures.push({
        source: `${type.index.documentTypeName} · ${type.index.indexName}`,
        message: errorMessage(e),
      });
    }
    type.sweeping = false;
    emit();
  }

  if (aborted()) {
    pump.cancel();
    return view;
  }
  await Promise.all(settled);
  return view;
}
