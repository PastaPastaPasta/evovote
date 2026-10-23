import type { EvoSDK } from '@dashevo/evo-sdk';
import { useSyncExternalStore } from 'react';
import type { Cap, Failure } from '../discovery/types';
import { knownContractById, type KnownContract } from '../config/knownContracts';
import { isBase58Identifier as isContractId } from '../model/bytes';
import { errorMessage } from '../sdk/errors';
import type { Network } from '../sdk/network';
import { charterKind } from '../kinds/charter';
import type { ElectionPhase } from './phase';
import { charterTarget } from './pollKey';
import { fetchTargetsPage } from './reads';

/**
 * The moderated-contract directory (`#/m`), found on chain: the union of
 * - every target with a proposal (`submittedCharter`),
 * - every target ever contested (the charters `contestedResources` sweep),
 * - every target with a seated team (`electedCharter` documents, which
 *   exist only once a contest is won),
 * - contract ids the user added (this browser, per network).
 * The site's known contracts (config/knownContracts.ts) only label them.
 */
export type DirectorySource = 'proposed' | 'contested' | 'seated' | 'added';

export interface DirectoryEntry {
  id: string;
  sources: DirectorySource[];
}

/** The network-derived part of the directory; user-added ids are merged in by the page. */
export interface DirectoryIds {
  proposed: string[];
  contested: string[];
  seated: string[];
  failures: Failure[];
  caps: Cap[];
}

// ---- user-added ids ----------------------------------------------------------

const storageKey = (network: Network) => `evovote.moderated.${network}`;
const addedListeners = new Set<() => void>();
const addedSnapshots = new Map<Network, string[]>();

function readAdded(network: Network): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(network)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && isContractId(x)) : [];
  } catch {
    return [];
  }
}

function addedContracts(network: Network): string[] {
  let snapshot = addedSnapshots.get(network);
  if (!snapshot) {
    snapshot = readAdded(network);
    addedSnapshots.set(network, snapshot);
  }
  return snapshot;
}

function writeAdded(network: Network, ids: string[]): void {
  addedSnapshots.set(network, ids);
  try {
    localStorage.setItem(storageKey(network), JSON.stringify(ids));
  } catch {
    // Storage disabled: the list lasts for this tab only.
  }
  for (const listener of addedListeners) listener();
}

/** Add a contract id to this browser's directory. Returns a problem, or undefined. */
export function addContract(network: Network, id: string): string | undefined {
  const trimmed = id.trim();
  if (!isContractId(trimmed)) return 'That is not a contract id (base58, 32 bytes).';
  const current = addedContracts(network);
  if (current.includes(trimmed)) return 'That contract is already in your list.';
  writeAdded(network, [...current, trimmed]);
  return undefined;
}

export function removeContract(network: Network, id: string): void {
  writeAdded(
    network,
    addedContracts(network).filter((x) => x !== id),
  );
}

export function useAddedContracts(network: Network): string[] {
  return useSyncExternalStore(
    (listener) => {
      addedListeners.add(listener);
      return () => addedListeners.delete(listener);
    },
    () => addedContracts(network),
  );
}

// ---- discovery ----------------------------------------------------------------

/** Most targets one source lists before it stops and says so. */
export const MAX_DISCOVERED_TARGETS = 500;
/** Most pages one source reads: each page adds at least one target. */
const MAX_DISCOVERY_PAGES = 20;
const DISCOVERY_PAGE = 100;

/**
 * Walk an index ordered by target, one page per call of `fetchPage(after)`
 * (the documents of the targets after `after`, one entry per document),
 * and collect each target once, in index order. A full page moves on past
 * its last target, so every page adds at least one. Stops at `max` targets
 * or `maxPages` pages (`capped`). Throws when a page fails, or when a page
 * does not move past `after` (a node ignoring the range would loop).
 */
export async function walkDistinctTargets(
  fetchPage: (after: string | undefined) => Promise<string[]>,
  { pageSize = DISCOVERY_PAGE, max = MAX_DISCOVERED_TARGETS, maxPages = MAX_DISCOVERY_PAGES } = {},
): Promise<{ ids: string[]; capped: boolean }> {
  const seen = new Set<string>();
  let after: string | undefined;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await fetchPage(after);
    const before = seen.size;
    for (const id of page) if (id) seen.add(id);
    if (seen.size > max) return { ids: [...seen].slice(0, max), capped: true };
    if (page.length < pageSize) return { ids: [...seen], capped: false };
    const last = [...page].reverse().find((id) => id !== '');
    if (!last || seen.size === before) throw new Error('the target walk did not move on');
    after = last;
  }
  return { ids: [...seen].slice(0, max), capped: true };
}

/** Whether `#/m` leaves a discovered contract out (a known contract with no moderator election). */
export function hiddenFromDirectory(id: string): boolean {
  return knownContractById(id)?.directory === false;
}

/**
 * Pure: merge the sources, keeping each id once with every source it came
 * from. A discovered id the site hides is left out unless the user added it.
 */
export function mergeDirectory(
  found: Pick<DirectoryIds, 'proposed' | 'contested' | 'seated'>,
  added: readonly string[],
  hidden: (id: string) => boolean = hiddenFromDirectory,
): DirectoryEntry[] {
  const byId = new Map<string, DirectorySource[]>();
  const put = (id: string, source: DirectorySource) => {
    const sources = byId.get(id) ?? [];
    if (!sources.includes(source)) sources.push(source);
    byId.set(id, sources);
  };
  found.contested.forEach((id) => put(id, 'contested'));
  found.proposed.forEach((id) => put(id, 'proposed'));
  found.seated.forEach((id) => put(id, 'seated'));
  added.forEach((id) => put(id, 'added'));
  return [...byId]
    .filter(([id, sources]) => sources.includes('added') || !hidden(id))
    .map(([id, sources]) => ({ id, sources }));
}

/** One source's distinct targets, its failure or its cap recorded. Never throws. */
async function discoverTargets(
  sdk: EvoSDK,
  documentTypeName: 'submittedCharter' | 'electedCharter',
  source: string,
  failures: Failure[],
  caps: Cap[],
): Promise<string[]> {
  try {
    const { ids, capped } = await walkDistinctTargets((after) => fetchTargetsPage(sdk, documentTypeName, after, DISCOVERY_PAGE));
    if (capped) caps.push({ source, limit: ids.length });
    return ids;
  } catch (e) {
    failures.push({ source, message: errorMessage(e) });
    return [];
  }
}

/** Every target contested for a seat (the vote-poll archive). Never throws. */
async function discoverContested(sdk: EvoSDK, failures: Failure[], caps: Cap[]): Promise<string[]> {
  const contested: string[] = [];
  try {
    for await (const page of charterKind.archive!(sdk)) {
      for (const key of page.keys) {
        const target = charterTarget(key);
        if (target) contested.push(target);
      }
      if (page.failure) failures.push(page.failure);
      if (page.cap) caps.push(page.cap);
    }
  } catch (e) {
    failures.push({ source: 'contested moderation seats', message: errorMessage(e) });
  }
  return contested;
}

/** The contracts with a proposal, a contest or a seated team, read from chain in parallel. Never throws. */
export async function collectDirectoryIds(sdk: EvoSDK): Promise<DirectoryIds> {
  const failures: Failure[] = [];
  const caps: Cap[] = [];
  const [proposed, contested, seated] = await Promise.all([
    discoverTargets(sdk, 'submittedCharter', 'contracts with moderator proposals', failures, caps),
    discoverContested(sdk, failures, caps),
    discoverTargets(sdk, 'electedCharter', 'contracts with a seated moderator team', failures, caps),
  ]);
  return { proposed, contested, seated, failures, caps };
}

/** How long `#/m` reuses what it found, within one page load. */
const DISCOVERY_TTL_MS = 5 * 60_000;
const discovered = new Map<Network, { at: number; ids: Promise<DirectoryIds> }>();

/** Drop what `#/m` found, so the next visit reads again (after filing a proposal or an application). */
export function forgetDirectory(): void {
  discovered.clear();
}

/**
 * `collectDirectoryIds`, reused for a few minutes per network so going back
 * to `#/m` is instant. A result with failures is not kept: the next visit
 * tries again.
 */
export function discoverDirectory(sdk: EvoSDK, network: Network, now = Date.now()): Promise<DirectoryIds> {
  const hit = discovered.get(network);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.ids;
  const ids = collectDirectoryIds(sdk);
  const entry = { at: now, ids };
  discovered.set(network, entry);
  void ids.then((value) => {
    if (value.failures.length > 0 && discovered.get(network) === entry) discovered.delete(network);
  });
  return ids;
}

// ---- grouping and labels -------------------------------------------------------

/**
 * Which section of `#/m` an election is listed in, by its phase (see
 * charters/phase.ts): a contest under way, proposals waiting for a team to
 * apply, a filled seat, or anything else (not elected, unreadable).
 */
export type DirectoryGroup = 'open' | 'waiting' | 'decided' | 'other';

export function directoryGroup(phase: ElectionPhase | undefined): DirectoryGroup {
  switch (phase) {
    case 'join-window':
    case 'voting':
    case 'closing':
      return 'open';
    case 'notice':
    case 'no-election':
    case 'proposals':
      return 'waiting';
    case 'seated':
    case 'decided':
      return 'decided';
    default:
      return 'other';
  }
}

const ABOUT_MAX = 140;

/** Text a contract owner wrote, made safe to show inline: no control or bidi/format characters, one line. */
function plainText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a contract's JSON says about itself: its description, else its keywords. Pure. */
export function contractAbout(contractJson: unknown): string | undefined {
  const json = contractJson as { description?: unknown; keywords?: unknown } | undefined;
  const description = typeof json?.description === 'string' ? [...plainText(json.description)] : [];
  if (description.length > 0) {
    return description.length > ABOUT_MAX ? `${description.slice(0, ABOUT_MAX - 1).join('').trimEnd()}…` : description.join('');
  }
  const keywords = Array.isArray(json?.keywords)
    ? json.keywords.filter((k): k is string => typeof k === 'string').map(plainText).filter((k) => k !== '')
    : [];
  return keywords.length > 0 ? `Keywords: ${keywords.join(', ')}` : undefined;
}

/**
 * The words before a card's short id: the site's note for a known contract;
 * else what the contract says about itself and what it moderates. Pure.
 */
export function directoryNote(
  known: Pick<KnownContract, 'note'> | undefined,
  about: string | undefined,
  moderatedTypes: readonly string[],
): string[] {
  if (known?.note) return [known.note];
  const moderates = moderatedTypes.length > 0 ? `Moderates ${moderatedTypes.join(', ')}` : undefined;
  return [about, moderates].filter((x): x is string => !!x);
}
