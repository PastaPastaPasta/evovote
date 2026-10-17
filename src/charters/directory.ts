import type { EvoSDK } from '@dashevo/evo-sdk';
import { useSyncExternalStore } from 'react';
import type { Cap, Failure } from '../discovery/types';
import { knownContracts } from '../config/knownContracts';
import { isBase58Identifier as isContractId } from '../model/bytes';
import { errorMessage } from '../sdk/errors';
import type { Network } from '../sdk/network';
import { charterKind, charterTarget } from '../kinds/charter';
import type { ContractModeration } from './declaration';
import { fetchModeration, fetchTeam, type TeamView } from './reads';

/**
 * The moderated-contract directory (`#/m`): the union of
 * - the known contracts of this network (config),
 * - every target ever contested (the charters `contestedResources` sweep),
 * - contract ids the user added (this browser, per network).
 */
export type DirectorySource = 'known' | 'contested' | 'added';

export interface DirectoryIds {
  entries: Array<{ id: string; sources: DirectorySource[] }>;
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

export function addedContracts(network: Network): string[] {
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

// ---- the union ---------------------------------------------------------------

/** Pure: merge the three sources, known first, keeping each id once. */
export function mergeDirectory(known: string[], contested: string[], added: string[]): DirectoryIds['entries'] {
  const byId = new Map<string, DirectorySource[]>();
  const put = (id: string, source: DirectorySource) => {
    const sources = byId.get(id) ?? [];
    if (!sources.includes(source)) sources.push(source);
    byId.set(id, sources);
  };
  known.forEach((id) => put(id, 'known'));
  contested.forEach((id) => put(id, 'contested'));
  added.forEach((id) => put(id, 'added'));
  return [...byId].map(([id, sources]) => ({ id, sources }));
}

/** Every contract the directory lists. Never throws. */
export async function collectDirectoryIds(sdk: EvoSDK, network: Network): Promise<DirectoryIds> {
  const failures: Failure[] = [];
  const caps: Cap[] = [];
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
  return {
    entries: mergeDirectory(
      knownContracts(network).map((c) => c.id),
      contested,
      addedContracts(network),
    ),
    failures,
    caps,
  };
}

export interface DirectoryEntryState {
  /** False when the contract does not exist; undefined when its read failed. */
  found?: boolean;
  moderation?: ContractModeration;
  team?: TeamView;
  failures: Failure[];
}

/** One directory row's declaration and seat. Never throws. */
export async function fetchDirectoryEntry(sdk: EvoSDK, contractId: string): Promise<DirectoryEntryState> {
  const failures: Failure[] = [];
  const [moderation, team] = await Promise.all([
    fetchModeration(sdk, contractId).catch((e: unknown) => {
      failures.push({ source: 'the contract', message: errorMessage(e) });
      return 'failed' as const;
    }),
    fetchTeam(sdk, contractId).catch((e: unknown) => {
      failures.push({ source: 'the seated team', message: errorMessage(e) });
      return undefined;
    }),
  ]);
  if (moderation === 'failed') return { failures, team };
  return { found: moderation !== undefined, moderation, team, failures };
}
