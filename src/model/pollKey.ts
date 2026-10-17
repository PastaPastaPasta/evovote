import {
  asBytes,
  decodeBincodeValue,
  indexValueFromJs,
  indexValueFromJson,
  indexValueToJson,
  type IndexValue,
} from './indexValue';

/**
 * Identifies one contested resource (one vote poll) anywhere on Platform:
 * the contract, the document type, its contested unique index, and the
 * values of that index.
 */
export interface PollKey {
  contractId: string;
  documentTypeName: string;
  indexName: string;
  indexValues: IndexValue[];
}

// ---- canonical string ---------------------------------------------------------
//
//   <contractId>/<docType>/<indexName>/<base64url(JSON of typed indexValues)>
//
// Used for routes (#/p/<key>), caches, vote receipts and the discussion scope,
// so it must be deterministic: the same poll always yields the same string.
// Segments are URI-component encoded; base58 ids and Platform type/index names
// never need it in practice, but a hostile contract could name things oddly.

function base64UrlEncode(textValue: string): string {
  const bytes = new TextEncoder().encode(textValue);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('bad base64url');
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodePollKey(key: PollKey): string {
  const values = base64UrlEncode(JSON.stringify(key.indexValues.map(indexValueToJson)));
  return [key.contractId, key.documentTypeName, key.indexName]
    .map(encodeURIComponent)
    .concat(values)
    .join('/');
}

/** Inverse of encodePollKey; undefined for anything malformed. */
export function decodePollKey(encoded: string): PollKey | undefined {
  const parts = encoded.split('/');
  if (parts.length !== 4) return undefined;
  try {
    const [contractId, documentTypeName, indexName] = parts
      .slice(0, 3)
      .map(decodeURIComponent);
    if (!contractId || !documentTypeName || !indexName) return undefined;
    const json: unknown = JSON.parse(base64UrlDecode(parts[3]));
    if (!Array.isArray(json)) return undefined;
    return {
      contractId,
      documentTypeName,
      indexName,
      indexValues: json.map(indexValueFromJson),
    };
  } catch {
    return undefined;
  }
}

export function pollKeysEqual(a: PollKey, b: PollKey): boolean {
  return encodePollKey(a) === encodePollKey(b);
}

// ---- from SDK objects --------------------------------------------------------

/** The structural shape of a wasm `VotePoll` this module reads. */
export interface SdkVotePollLike {
  contractId: { toBase58(): string } | string;
  documentTypeName: string;
  indexName: string;
  indexValues: unknown[];
}

/**
 * The PollKey of a VotePoll read from chain (votePollsByEndDate entries,
 * contestedResourceIdentityVotes). Its `indexValues` are bincode-serialized
 * Platform Values and are decoded with their types kept.
 */
export function pollKeyFromSdkPoll(poll: SdkVotePollLike): PollKey {
  const contractId =
    typeof poll.contractId === 'string' ? poll.contractId : poll.contractId.toBase58();
  const indexValues = Array.from(poll.indexValues ?? []).map((raw): IndexValue => {
    const bytes = asBytes(raw);
    if (bytes) return decodeBincodeValue(bytes);
    // Not expected from rc.4 (values are always bytes); keep the poll visible.
    return indexValueFromJs(raw) ?? { type: 'null' };
  });
  return {
    contractId,
    documentTypeName: poll.documentTypeName,
    indexName: poll.indexName,
    indexValues,
  };
}
