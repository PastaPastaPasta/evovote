import { useSyncExternalStore } from 'react';
import { base64ToBytesSafe, bytesToHex } from '../model/bytes';
import { loadSdk } from '../sdk/connection';
import { errorMessage } from '../sdk/errors';
import type { Network } from '../sdk/network';
import { isProTxHash, p2pkhAddress, voterIdentityId, wifNetwork } from './keys';

/**
 * The masternode keyring.
 *
 * ProTxHashes and labels are public and persist per network. Voting keys
 * (WIFs) live only in the in-memory map below and vanish with the tab;
 * persisting them is not offered. A key is accepted only after its voter
 * identity, SHA256(proTxHash ‖ HASH160(pub)), is read from Platform and its
 * key 0 matches HASH160(pub): that proves the key is this node's voting key
 * before anything is signed with it.
 */
export interface Masternode {
  id: string;
  label: string;
  /** Hex as Core RPC shows it (`protx list`). */
  proTxHash: string;
  /** Set while a verified voting key is held in memory for this session. */
  hasKey: boolean;
  /** Core voting address derived from the key, for the operator to compare. */
  votingAddress?: string;
  /** The Platform identity this node votes as (base58). */
  voterId?: string;
}

/** What the signer needs; never leaves this module except to sign. */
export interface LoadedKey {
  wif: string;
  address: string;
  /** HASH160 of the public key, hex: the voting key's data (key id 0). */
  hash160: string;
  voterId: string;
}

interface StoredEntry {
  id: string;
  label: string;
  proTxHash: string;
}

const keys = new Map<string, LoadedKey>();

let network: Network = 'testnet';
let entries: StoredEntry[] = [];
let snapshot: Masternode[] = [];
const listeners = new Set<() => void>();

const storageKey = () => `evovote.mns.${network}`;

function rebuildSnapshot(): void {
  snapshot = entries.map((entry) => {
    const key = keys.get(entry.id);
    return { ...entry, hasKey: !!key, votingAddress: key?.address, voterId: key?.voterId };
  });
  for (const listener of listeners) listener();
}

function persist(): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(entries));
  } catch {
    // Storage disabled: the list lasts for this tab only.
  }
}

export function initKeyring(activeNetwork: Network): void {
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

export function useMasternodes(): Masternode[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function getMasternodes(): Masternode[] {
  return snapshot;
}

export function getLoadedKey(id: string): LoadedKey | undefined {
  return keys.get(id);
}

export interface KeyringResult {
  ok: boolean;
  error?: string;
}

export async function addMasternode(input: {
  label?: string;
  proTxHash: string;
  wif?: string;
}): Promise<KeyringResult> {
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
    { id, label: input.label?.trim() || `MN ${entries.length + 1}`, proTxHash },
  ];
  persist();
  rebuildSnapshot();
  if (input.wif?.trim()) {
    const result = await importKey(id, input.wif);
    if (!result.ok) return { ok: true, error: `Added, but key rejected: ${result.error}` };
  }
  return { ok: true };
}

/** The voting key a voter identity holds: key 0, VOTING, over HASH160(pub). */
export function voterKeyMatches(
  key: { purpose?: unknown; data?: unknown } | undefined,
  hash160Hex: string,
): boolean {
  if (!key) return false;
  // toJSON() gives purpose as a number (5 = VOTING) and data as base64.
  if (key.purpose !== 5 && key.purpose !== 'VOTING' && key.purpose !== 'voting') return false;
  const data =
    key.data instanceof Uint8Array
      ? key.data
      : typeof key.data === 'string'
        ? base64ToBytesSafe(key.data)
        : undefined;
  return data !== undefined && bytesToHex(data) === hash160Hex.toLowerCase();
}

export async function importKey(id: string, wif: string): Promise<KeyringResult> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'Unknown masternode.' };
  const trimmed = wif.trim();
  const keyNetwork = wifNetwork(trimmed);
  if (!keyNetwork) return { ok: false, error: 'Not a valid Dash private key (WIF).' };
  if (keyNetwork !== network) {
    return { ok: false, error: `This is a ${keyNetwork} key, but you are on ${network}.` };
  }
  try {
    const { sdk, mod } = await loadSdk(network);
    const privateKey = mod.PrivateKey.fromWIF(trimmed);
    let hash160: string;
    try {
      hash160 = privateKey.getPublicKeyHash().toLowerCase();
    } finally {
      privateKey.free();
    }
    const voterId = await voterIdentityId(entry.proTxHash, hash160);
    const identity = await sdk.identities.fetch(voterId);
    if (!identity) {
      return {
        ok: false,
        error:
          'Platform has no voter identity for this ProTxHash and key. The key is not this ' +
          "masternode's voting key (compare votingAddress in protx info), or the ProTxHash is wrong.",
      };
    }
    let matches: boolean;
    try {
      const key0 = identity.getPublicKeyById(0);
      matches = voterKeyMatches(key0?.toJSON() as { purpose?: unknown; data?: unknown }, hash160);
      key0?.free();
    } finally {
      identity.free();
    }
    if (!matches) {
      return {
        ok: false,
        error: "The voter identity's key does not match this private key. Nothing was loaded.",
      };
    }
    const address = await p2pkhAddress(hash160, network);
    keys.set(id, { wif: trimmed, address, hash160, voterId });
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
export async function bulkImport(textValue: string): Promise<BulkResult> {
  const result: BulkResult = { added: 0, keysLoaded: 0, errors: [] };
  const lines = textValue
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const [index, line] of lines.entries()) {
    const [proTxHash, wif, label] = line.split(',').map((p) => p.trim());
    const existing = entries.find((e) => e.proTxHash === proTxHash?.toLowerCase());
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
