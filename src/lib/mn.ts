import { useSyncExternalStore } from 'react';
import { errorMessage, loadSdk, type Network } from './sdk';
import { isProTxHash, p2pkhAddress, wifNetwork } from './keys';

export interface Masternode {
  id: string;
  label: string;
  proTxHash: string;
  /** Set while a voting key is held in memory for this session. */
  hasKey: boolean;
  /** Core voting address derived from the imported key, for the user to verify. */
  votingAddress?: string;
}

interface StoredEntry {
  id: string;
  label: string;
  proTxHash: string;
}

// ProTxHashes and labels are public information and persist across sessions.
// Voting keys (WIFs) live only in this in-memory map and vanish with the tab.
const keys = new Map<string, { wif: string; address: string }>();

let network: Network = 'mainnet';
let entries: StoredEntry[] = [];
let snapshot: Masternode[] = [];
const listeners = new Set<() => void>();

function storageKey(): string {
  return `evovote.mns.${network}`;
}

function rebuildSnapshot(): void {
  snapshot = entries.map((entry) => ({
    ...entry,
    hasKey: keys.has(entry.id),
    votingAddress: keys.get(entry.id)?.address,
  }));
  for (const listener of listeners) listener();
}

function persist(): void {
  localStorage.setItem(storageKey(), JSON.stringify(entries));
}

export function initMnStore(activeNetwork: Network): void {
  network = activeNetwork;
  try {
    const raw = localStorage.getItem(storageKey());
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    entries = Array.isArray(parsed)
      ? parsed.filter(
          (e): e is StoredEntry =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as StoredEntry).id === 'string' &&
            typeof (e as StoredEntry).label === 'string' &&
            isProTxHash((e as StoredEntry).proTxHash ?? ''),
        )
      : [];
  } catch {
    entries = [];
  }
  rebuildSnapshot();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Masternode[] {
  return snapshot;
}

export function useMasternodes(): Masternode[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getWif(id: string): string | undefined {
  return keys.get(id)?.wif;
}

export interface AddMnResult {
  ok: boolean;
  error?: string;
}

export async function addMasternode(input: {
  label?: string;
  proTxHash: string;
  wif?: string;
}): Promise<AddMnResult> {
  const proTxHash = input.proTxHash.trim().toLowerCase();
  if (!isProTxHash(proTxHash)) {
    return { ok: false, error: 'ProTxHash must be 64 hex characters.' };
  }
  if (entries.some((e) => e.proTxHash === proTxHash)) {
    return { ok: false, error: 'That masternode is already in the list.' };
  }
  const id = crypto.randomUUID();
  entries = [
    ...entries,
    {
      id,
      label: input.label?.trim() || `MN ${entries.length + 1}`,
      proTxHash,
    },
  ];
  persist();
  rebuildSnapshot();
  if (input.wif?.trim()) {
    const result = await importKey(id, input.wif);
    if (!result.ok) return { ok: true, error: `Added, but key rejected: ${result.error}` };
  }
  return { ok: true };
}

export async function importKey(id: string, wif: string): Promise<AddMnResult> {
  const trimmed = wif.trim();
  const keyNetwork = wifNetwork(trimmed);
  if (!keyNetwork) {
    return { ok: false, error: 'Not a valid Dash private key (WIF).' };
  }
  if (keyNetwork !== network) {
    return {
      ok: false,
      error: `This is a ${keyNetwork} key, but you are on ${network}.`,
    };
  }
  try {
    const { mod } = await loadSdk(network);
    const key = mod.PrivateKey.fromWIF(trimmed);
    const address = await p2pkhAddress(key.getPublicKeyHash(), network);
    keys.set(id, { wif: trimmed, address });
    rebuildSnapshot();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export function forgetKey(id: string): void {
  keys.delete(id);
  rebuildSnapshot();
}

export function removeMasternode(id: string): void {
  keys.delete(id);
  entries = entries.filter((e) => e.id !== id);
  persist();
  rebuildSnapshot();
}

export function renameMasternode(id: string, label: string): void {
  entries = entries.map((e) => (e.id === id ? { ...e, label } : e));
  persist();
  rebuildSnapshot();
}

export interface BulkResult {
  added: number;
  keysLoaded: number;
  errors: string[];
}

/**
 * Bulk import, one masternode per line:
 *   <proTxHash>[,<voting WIF>][,<label>]
 * Lines starting with # are ignored.
 */
export async function bulkImport(text: string): Promise<BulkResult> {
  const result: BulkResult = { added: 0, keysLoaded: 0, errors: [] };
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const [index, line] of lines.entries()) {
    const parts = line.split(',').map((p) => p.trim());
    const [proTxHash, wif, label] = parts;
    const existing = entries.find(
      (e) => e.proTxHash === proTxHash?.toLowerCase(),
    );
    if (existing) {
      if (wif) {
        const keyResult = await importKey(existing.id, wif);
        if (keyResult.ok) result.keysLoaded += 1;
        else result.errors.push(`Line ${index + 1}: ${keyResult.error}`);
      }
      continue;
    }
    const added = await addMasternode({ proTxHash: proTxHash ?? '', wif, label });
    if (!added.ok) {
      result.errors.push(`Line ${index + 1}: ${added.error}`);
      continue;
    }
    result.added += 1;
    if (added.error) result.errors.push(`Line ${index + 1}: ${added.error}`);
    else if (wif) result.keysLoaded += 1;
  }
  return result;
}
