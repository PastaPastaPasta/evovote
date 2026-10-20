import { shortId } from '../model/text';
import { freeQuietly } from '../sdk/free';

/**
 * Identity keys as the session shows and checks them. Built from the SDK's
 * `IdentityPublicKey` getters by `keyInfoFrom` (or `keyInfosOf`), then checked
 * by pure functions here.
 *
 * Getter values on rc.4: purpose `AUTHENTICATION|ENCRYPTION|DECRYPTION|
 * TRANSFER|SYSTEM|VOTING|OWNER`, securityLevel `MASTER|CRITICAL|HIGH|MEDIUM`,
 * keyType `ECDSA_SECP256K1|BLS12_381|ECDSA_HASH160|...`, `data` hex,
 * `contractBounds.toJSON()` `{ $type, id, documentTypeName? }` with `$type`
 * `singleContract | documentType | contractGroup`, and for V1 keys
 * `totalBudget` (credits) and `expiresAt` (block time, ms).
 */

/**
 * A key's contract bounds. `$type` is kept: a `contractGroup` bound's id is a
 * group, not a contract, and a `documentType` bound signs only that type.
 * Bounds that cannot be read are `unknown` and never treated as unbound.
 */
export type KeyBounds =
  | { kind: 'singleContract'; contractId: string }
  | { kind: 'documentType'; contractId: string; documentTypeName: string }
  | { kind: 'contractGroup'; groupId: string }
  | { kind: 'unknown' };

export interface KeyInfo {
  keyId: number;
  purpose: string;
  securityLevel: string;
  keyType: string;
  readOnly: boolean;
  disabled: boolean;
  bounds?: KeyBounds;
  /** The key's data as hex: a compressed public key, or a hash160. */
  dataHex: string;
  /** HASH160 of the public key, hex (for ECDSA_HASH160 keys, the data itself). */
  hash160: string;
  /** V1 limit: the credits the key may spend over its lifetime. */
  totalBudget?: bigint;
  /** V1 limit: block time (ms) from which the key can no longer sign. */
  expiresAt?: number;
}

/** The structural shape of a wasm IdentityPublicKey this module reads. */
interface SdkKeyLike {
  keyId: number;
  purpose: string;
  securityLevel: string;
  keyType: string;
  isReadOnly: boolean;
  disabledAt?: bigint | number;
  data: string;
  contractBounds?: { toJSON(): unknown };
  totalBudget?: bigint | null;
  expiresAt?: bigint | number | null;
  getPublicKeyHash(): string;
}

/** Bounds from `contractBounds.toJSON()`; `unknown` for anything this app cannot read. */
export function boundsFromJson(json: unknown): KeyBounds {
  const b = json as { $type?: unknown; id?: unknown; documentTypeName?: unknown } | null | undefined;
  if (!b || typeof b.id !== 'string') return { kind: 'unknown' };
  switch (b.$type) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: b.id };
    case 'documentType':
      return typeof b.documentTypeName === 'string'
        ? { kind: 'documentType', contractId: b.id, documentTypeName: b.documentTypeName }
        : { kind: 'unknown' };
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: b.id };
    default:
      return { kind: 'unknown' };
  }
}

export function keyInfoFrom(k: SdkKeyLike): KeyInfo {
  let bounds: KeyBounds | undefined;
  try {
    const json = k.contractBounds?.toJSON();
    if (json !== undefined && json !== null) bounds = boundsFromJson(json);
  } catch {
    // Unreadable bounds: bound to something unknown, never unbound.
    bounds = { kind: 'unknown' };
  }
  const expiresAt = k.expiresAt === null || k.expiresAt === undefined ? undefined : Number(k.expiresAt);
  return {
    keyId: k.keyId,
    purpose: String(k.purpose).toUpperCase(),
    securityLevel: String(k.securityLevel).toUpperCase(),
    keyType: String(k.keyType).toUpperCase(),
    readOnly: k.isReadOnly,
    disabled: k.disabledAt !== undefined && k.disabledAt !== null,
    bounds,
    dataHex: String(k.data).toLowerCase(),
    hash160: k.getPublicKeyHash().toLowerCase(),
    ...(k.totalBudget !== null && k.totalBudget !== undefined ? { totalBudget: k.totalBudget } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/** Read every key of a fetched identity, freeing each wasm key object. */
export function keyInfosOf(identity: { publicKeys: SdkKeyLike[] }): KeyInfo[] {
  return identity.publicKeys.map((k) => {
    try {
      return keyInfoFrom(k);
    } finally {
      freeQuietly(k);
    }
  });
}

export function isMasterKey(k: KeyInfo): boolean {
  return !k.disabled && k.purpose === 'AUTHENTICATION' && k.securityLevel === 'MASTER';
}

/** An enabled AUTHENTICATION key of HIGH or CRITICAL level: what a document batch accepts (not MASTER, not MEDIUM). */
export function isDocumentSigningKey(k: KeyInfo): boolean {
  return (
    !k.disabled && k.purpose === 'AUTHENTICATION' && (k.securityLevel === 'HIGH' || k.securityLevel === 'CRITICAL')
  );
}

/**
 * Whether a key's bounds admit a document write of `documentType` on
 * `contractId`: unbound, bound to that contract, or bound to exactly that
 * document type of it. A group bound cannot be checked here (its members
 * are not read), and unknown bounds never pass.
 */
export function boundsAllow(bounds: KeyBounds | undefined, contractId: string, documentType?: string): boolean {
  if (!bounds) return true;
  switch (bounds.kind) {
    case 'singleContract':
      return bounds.contractId === contractId;
    case 'documentType':
      return bounds.contractId === contractId && documentType !== undefined && bounds.documentTypeName === documentType;
    case 'contractGroup':
    case 'unknown':
      return false;
  }
}

/**
 * Whether a key can sign document writes of `documentType` on `contractId`:
 * an enabled AUTHENTICATION key of HIGH or CRITICAL level whose bounds admit
 * the write. Without `documentType`, a document-type bound key never passes.
 */
export function canSignDocumentsFor(k: KeyInfo, contractId: string, documentType?: string): boolean {
  return isDocumentSigningKey(k) && boundsAllow(k.bounds, contractId, documentType);
}

/** "the moderation charters contract", or a short id. */
function boundsText(bounds: KeyBounds, contractName: (id: string) => string): string {
  switch (bounds.kind) {
    case 'singleContract':
      return contractName(bounds.contractId);
    case 'documentType':
      return `${bounds.documentTypeName} documents of ${contractName(bounds.contractId)}`;
    case 'contractGroup':
      return `the contract group ${shortId(bounds.groupId)}`;
    case 'unknown':
      return 'a contract EvoVote cannot read';
  }
}

/**
 * Why a key cannot be used to sign in (undefined when it can), naming the
 * keys of this identity that would work. A sign-in key must sign documents
 * on at least one of `contracts` (the contracts EvoVote writes to).
 */
export function signInKeyRefusal(
  k: KeyInfo,
  keys: readonly KeyInfo[],
  contracts: readonly string[],
  contractName: (id: string) => string = (id) => `contract ${shortId(id)}`,
): string | undefined {
  const usable = (key: KeyInfo) => isDocumentSigningKey(key) && contracts.some((c) => boundsAllow(key.bounds, c, key.bounds?.kind === 'documentType' ? key.bounds.documentTypeName : undefined));
  const alternatives = keys.filter((key) => key.keyId !== k.keyId && usable(key));
  const useInstead =
    alternatives.length > 0
      ? `Use ${alternatives.length === 1 ? 'its' : 'one of its'} HIGH or CRITICAL authentication ${alternatives.length === 1 ? 'key' : 'keys'} instead: ${alternatives
          .map((key) => `key #${key.keyId} (${key.securityLevel})`)
          .join(', ')}.`
      : 'This identity has no HIGH or CRITICAL authentication key EvoVote can sign with, so it cannot sign in with a private key here.';
  if (k.disabled) return `Key #${k.keyId} of this identity is disabled. ${useInstead}`;
  if (k.purpose === 'AUTHENTICATION' && k.securityLevel === 'MASTER') {
    return `That is the identity's MASTER key. Never paste it to sign in. ${useInstead}`;
  }
  if (k.purpose !== 'AUTHENTICATION') {
    const role = PURPOSE_CLAUSE[k.purpose];
    return `Key #${k.keyId} is ${/^[AEIOU]/.test(k.purpose) ? 'an' : 'a'} ${k.purpose} key${role ? ` (it ${role})` : ''}; it cannot sign comments or filings. ${useInstead}`;
  }
  if (k.securityLevel !== 'HIGH' && k.securityLevel !== 'CRITICAL') {
    return `Key #${k.keyId} is a ${k.securityLevel} authentication key; Platform needs HIGH or CRITICAL to sign documents. ${useInstead}`;
  }
  if (k.bounds && !usable(k)) {
    return `Key #${k.keyId} is bound to ${boundsText(k.bounds, contractName)}, so it can only sign there. ${useInstead}`;
  }
  return undefined;
}

/** A key bound exactly to one document type of one contract (the schema's `boundTo`). */
export function isBoundKey(
  k: KeyInfo,
  purpose: 'ENCRYPTION' | 'DECRYPTION',
  contractId: string,
  documentTypeName: string,
): boolean {
  return (
    !k.disabled &&
    k.purpose === purpose &&
    k.bounds?.kind === 'documentType' &&
    k.bounds.contractId === contractId &&
    k.bounds.documentTypeName === documentTypeName
  );
}

/** The id a new key gets: one past the highest in use (disabled keys included). */
export function nextKeyId(keys: readonly { keyId: number }[]): number {
  return keys.reduce((max, k) => Math.max(max, k.keyId), -1) + 1;
}

/**
 * The identity key a private key belongs to: by public key for
 * ECDSA_SECP256K1 keys, by hash for ECDSA_HASH160 keys.
 */
export function keyMatching(
  keys: readonly KeyInfo[],
  publicKeyHex: string,
  hash160: string,
): KeyInfo | undefined {
  const pub = publicKeyHex.toLowerCase();
  const hash = hash160.toLowerCase();
  return keys.find((k) =>
    k.keyType === 'ECDSA_HASH160' ? k.dataHex === hash : k.dataHex === pub || k.hash160 === hash,
  );
}

/** What a non-signing key is for, as a clause after "it". */
const PURPOSE_CLAUSE: Record<string, string> = {
  ENCRYPTION: 'encrypts messages to others',
  DECRYPTION: 'decrypts messages sent to you',
  TRANSFER: 'withdraws and transfers credits',
  VOTING: 'is for masternode voting',
  OWNER: 'is for masternode ownership',
};

const PURPOSE_TEXT: Record<string, string> = {
  AUTHENTICATION: 'signs transitions',
  ENCRYPTION: 'encrypts messages to others',
  DECRYPTION: 'decrypts messages sent to you',
  TRANSFER: 'withdraws and transfers credits',
  VOTING: 'masternode voting',
  OWNER: 'masternode owner',
  SYSTEM: 'system',
};

/** One line describing a key, e.g. "AUTHENTICATION · HIGH — signs transitions". */
export function keyRoleText(k: KeyInfo): string {
  const role = PURPOSE_TEXT[k.purpose] ?? k.purpose.toLowerCase();
  return `${k.purpose} · ${k.securityLevel} — ${role}`;
}
