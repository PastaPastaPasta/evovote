import { base58Decode, base58Encode, base64ToBytesSafe, bytesToHex } from '../model/bytes';

/** One document field value, typed so the table can render it properly. */
export type FieldValue =
  | { kind: 'text'; text: string }
  /** A base58 identifier: shown short, with a copy button for the full id. */
  | { kind: 'identifier'; id: string }
  /** Binary data as lowercase hex (shown truncated, copied in full). */
  | { kind: 'bytes'; hex: string }
  /** A nested object or array, pretty-printed. */
  | { kind: 'json'; text: string };

export interface FieldRow {
  name: string;
  value: FieldValue;
}

/** System fields lead the table, in this order; the rest follow in document order. */
const SYSTEM_ORDER = ['$id', '$ownerId', '$revision', '$createdAt', '$updatedAt', '$transferredAt'];
const IDENTIFIER_SYSTEM_FIELDS = new Set(['$id', '$ownerId', '$dataContractId']);
const IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier';

interface PropertySchema {
  type?: unknown;
  byteArray?: unknown;
  contentMediaType?: unknown;
}

function isIdentifierText(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function jsonText(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value === 'string') return base64ToBytesSafe(value);
  return undefined;
}

/**
 * Type one field of a decoded document (`Document.toJSON`). The contract's
 * property schema, when known, says whether a string is an identifier and an
 * array is bytes; without it, a 32-byte base58 string is taken as an id.
 */
export function fieldValue(name: string, value: unknown, schema?: PropertySchema): FieldValue {
  const byteArray = schema?.byteArray === true;
  const schemaSaysIdentifier = byteArray && schema?.contentMediaType === IDENTIFIER_MEDIA_TYPE;
  if (typeof value === 'string') {
    if (IDENTIFIER_SYSTEM_FIELDS.has(name) || schemaSaysIdentifier) {
      if (isIdentifierText(value)) return { kind: 'identifier', id: value };
    }
    if (byteArray && !schemaSaysIdentifier) {
      const bytes = toBytes(value);
      if (bytes) return { kind: 'bytes', hex: bytesToHex(bytes) };
    }
    if (!schema && isIdentifierText(value)) return { kind: 'identifier', id: value };
    return { kind: 'text', text: value };
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return { kind: 'text', text: String(value) };
  }
  if (value === null || value === undefined) return { kind: 'text', text: 'null' };
  if (byteArray) {
    const bytes = toBytes(value);
    if (bytes) {
      return schemaSaysIdentifier && bytes.length === 32
        ? { kind: 'identifier', id: base58Encode(bytes) }
        : { kind: 'bytes', hex: bytesToHex(bytes) };
    }
  }
  return { kind: 'json', text: jsonText(value) };
}

/**
 * Rows for a contender's document: system fields first, then the contract's
 * own fields. `docSchema` is the document type's JSON schema, if known.
 */
export function documentRows(doc: Record<string, unknown>, docSchema?: unknown): FieldRow[] {
  const properties =
    (docSchema as { properties?: Record<string, PropertySchema> } | undefined)?.properties ?? {};
  const names = Object.keys(doc);
  const ordered = [
    ...SYSTEM_ORDER.filter((n) => names.includes(n)),
    ...names.filter((n) => !SYSTEM_ORDER.includes(n)),
  ];
  return ordered.map((name) => ({ name, value: fieldValue(name, doc[name], properties[name]) }));
}
