/**
 * Identity keys as the session shows and checks them. Pure: built from the
 * SDK's `IdentityPublicKey` getters by `keyInfoFrom`, then checked here.
 *
 * Getter values on rc.4: purpose `AUTHENTICATION|ENCRYPTION|DECRYPTION|
 * TRANSFER|SYSTEM|VOTING|OWNER`, securityLevel `MASTER|CRITICAL|HIGH|MEDIUM`,
 * keyType `ECDSA_SECP256K1|BLS12_381|ECDSA_HASH160|...`, `data` hex,
 * `contractBounds.toJSON()` `{ $type, id, documentTypeName? }`.
 */

export interface KeyBounds {
  contractId: string;
  /** Set for a document-type bound (`SingleContractDocumentType`). */
  documentTypeName?: string;
}

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
}

/** The structural shape of a wasm IdentityPublicKey this module reads. */
export interface SdkKeyLike {
  keyId: number;
  purpose: string;
  securityLevel: string;
  keyType: string;
  isReadOnly: boolean;
  disabledAt?: bigint | number;
  data: string;
  contractBounds?: { toJSON(): unknown };
  getPublicKeyHash(): string;
}

export function keyInfoFrom(k: SdkKeyLike): KeyInfo {
  let bounds: KeyBounds | undefined;
  try {
    const b = k.contractBounds?.toJSON() as { id?: unknown; documentTypeName?: unknown } | undefined;
    if (b && typeof b.id === 'string') {
      bounds = {
        contractId: b.id,
        ...(typeof b.documentTypeName === 'string' ? { documentTypeName: b.documentTypeName } : {}),
      };
    }
  } catch {
    // Unreadable bounds: treat as bound to something unknown below.
    bounds = { contractId: '?' };
  }
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
  };
}

export function isMasterKey(k: KeyInfo): boolean {
  return !k.disabled && k.purpose === 'AUTHENTICATION' && k.securityLevel === 'MASTER';
}

/**
 * Whether a key can sign document writes on `contractId`: an enabled
 * AUTHENTICATION key of HIGH or CRITICAL level (a batch refuses MASTER and
 * MEDIUM), unbound or bound to that contract.
 */
export function canSignDocumentsFor(k: KeyInfo, contractId: string): boolean {
  return (
    !k.disabled &&
    k.purpose === 'AUTHENTICATION' &&
    (k.securityLevel === 'HIGH' || k.securityLevel === 'CRITICAL') &&
    (k.bounds === undefined || k.bounds.contractId === contractId)
  );
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
    k.bounds?.contractId === contractId &&
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
