import { base64ToBytesSafe, hexToBytes } from '../model/bytes';
import type { AppConnectIdentityKey, AppConnectKeyBounds } from './protocol';

/**
 * The fields of a wasm `IdentityPublicKey` the App Connect code reads, as a
 * structural type so the mapping can be tested without the wasm module.
 * (From Yappr's lib/app-connect/key-mapping.ts.)
 */
export interface WasmIdentityKeyLike {
  keyId: number;
  keyTypeNumber: number;
  purposeNumber: number;
  securityLevelNumber: number;
  /** Hex (the wasm getter) or bytes. */
  data: unknown;
  disabledAt?: bigint | number | null;
  totalBudget?: bigint | null;
  expiresAt?: bigint | number | null;
  contractBounds?: { toJSON(): unknown } | null;
}

/** Bytes from a byte-array value as the SDK hands it back: bytes, a number array, hex (key data) or base64. */
export function bytesFrom(value: unknown, encoding: 'hex' | 'base64'): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    return value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 256) ? new Uint8Array(value) : null;
  }
  if (typeof value !== 'string' || value === '') return null;
  if (encoding === 'hex') {
    if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
    return hexToBytes(value);
  }
  return base64ToBytesSafe(value) ?? null;
}

function toBounds(bounds: WasmIdentityKeyLike['contractBounds']): AppConnectKeyBounds | undefined | null {
  if (!bounds) return undefined;
  const json = bounds.toJSON() as { $type?: unknown; id?: unknown; documentTypeName?: unknown };
  if (typeof json.id !== 'string') return null;
  switch (json.$type) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: json.id };
    case 'documentType':
      return typeof json.documentTypeName === 'string'
        ? { kind: 'documentType', contractId: json.id, documentTypeName: json.documentTypeName }
        : null;
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: json.id };
    default:
      return null;
  }
}

function toNumber(value: bigint | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Maps a wasm key to the verifier's shape, or null when it cannot be read
 * faithfully (unknown bounds kind, undecodable data). Callers treat null as a
 * key they must not use: an unreadable bound must never look unbound.
 */
export function toAppConnectIdentityKey(key: WasmIdentityKeyLike): AppConnectIdentityKey | null {
  const data = bytesFrom(key.data, 'hex');
  let bounds: AppConnectKeyBounds | undefined | null;
  try {
    bounds = toBounds(key.contractBounds);
  } catch {
    bounds = null;
  }
  if (!data || bounds === null) return null;
  return {
    id: key.keyId,
    type: key.keyTypeNumber,
    purpose: key.purposeNumber,
    securityLevel: key.securityLevelNumber,
    data,
    ...(key.disabledAt !== null && key.disabledAt !== undefined ? { disabledAt: toNumber(key.disabledAt) } : {}),
    ...(bounds ? { bounds } : {}),
    ...(key.totalBudget !== null && key.totalBudget !== undefined ? { totalBudget: key.totalBudget } : {}),
    ...(key.expiresAt !== null && key.expiresAt !== undefined ? { expiresAt: toNumber(key.expiresAt) } : {}),
  };
}

/** Maps every key and drops the unreadable ones, which then can neither verify nor sign. */
export function toAppConnectIdentityKeys(keys: readonly WasmIdentityKeyLike[]): AppConnectIdentityKey[] {
  return keys.flatMap((key) => {
    const mapped = toAppConnectIdentityKey(key);
    return mapped ? [mapped] : [];
  });
}
