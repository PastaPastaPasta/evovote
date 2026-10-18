import { base58Decode, base58Encode, bytesToHex, hexToBytes } from './bytes';

/**
 * One value of a contested index (e.g. the `"dash"` parent and the label of a
 * DPNS name, or the target contract id of a moderator election), with its
 * Platform Value type kept.
 *
 * The type matters: a vote poll's id is a hash of its *typed* values, so a
 * poll rebuilt with a Text where the chain holds an Identifier addresses a
 * poll (and contest fund) that does not exist (refused with 40401).
 */
export type IndexValue =
  | { type: 'text'; value: string }
  | { type: 'identifier'; value: string } // base58
  | { type: 'integer'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  /** Anything this decoder does not model (arrays, maps, enums): raw bincode. */
  | { type: 'raw'; value: Uint8Array };

export const text = (value: string): IndexValue => ({ type: 'text', value });
export const identifier = (value: string): IndexValue => ({ type: 'identifier', value });

// ---- bincode Value decoding ------------------------------------------------
//
// `VotePoll.indexValues` (wasm-dpp2) returns each value as
// `bincode::encode_to_vec(value, standard().with_big_endian())`: a varint enum
// tag in rs-platform-value's variant order, then the payload. The SDK has no
// Value class to decode these, and `VotePoll.toJSON()` renders an Identifier
// as a base58 string indistinguishable from Text, so the bytes are decoded
// here. Varints: < 251 is the value itself; 251/252/253/254 prefix a
// big-endian u16/u32/u64/u128. Signed integers are zigzag-encoded.

const TAG = {
  U128: 0,
  I128: 1,
  U64: 2,
  I64: 3,
  U32: 4,
  I32: 5,
  U16: 6,
  I16: 7,
  U8: 8,
  I8: 9,
  Bytes: 10,
  Bytes20: 11,
  Bytes32: 12,
  Bytes36: 13,
  // 14 EnumU8, 15 EnumString: not index-value types, decoded as raw.
  Identifier: 16,
  Float: 17,
  Text: 18,
  Bool: 19,
  Null: 20,
  // 21 Array, 22 Map: decoded as raw.
} as const;

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.bytes.length) throw new Error('truncated value');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  byte(): number {
    return this.take(1)[0];
  }

  bigEndian(n: number): bigint {
    let v = 0n;
    for (const b of this.take(n)) v = (v << 8n) | BigInt(b);
    return v;
  }

  varint(): bigint {
    const first = this.byte();
    if (first < 251) return BigInt(first);
    if (first === 251) return this.bigEndian(2);
    if (first === 252) return this.bigEndian(4);
    if (first === 253) return this.bigEndian(8);
    if (first === 254) return this.bigEndian(16);
    throw new Error('invalid varint');
  }

  length(): number {
    const n = this.varint();
    if (n > BigInt(this.bytes.length)) throw new Error('length exceeds value');
    return Number(n);
  }

  get done(): boolean {
    return this.pos === this.bytes.length;
  }
}

const zigzag = (n: bigint): bigint => (n & 1n ? -((n + 1n) >> 1n) : n >> 1n);

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode one bincode-serialized Platform Value. Never throws: bytes that do
 * not decode cleanly (including trailing garbage) come back as `raw`, so a
 * poll is always representable and round-trips through its PollKey.
 */
export function decodeBincodeValue(bytes: Uint8Array): IndexValue {
  try {
    const r = new Reader(bytes);
    const tag = r.varint();
    let value: IndexValue;
    switch (Number(tag)) {
      case TAG.U128:
      case TAG.U64:
      case TAG.U32:
      case TAG.U16:
        value = { type: 'integer', value: r.varint() };
        break;
      case TAG.I128:
      case TAG.I64:
      case TAG.I32:
      case TAG.I16:
        value = { type: 'integer', value: zigzag(r.varint()) };
        break;
      case TAG.U8:
        value = { type: 'integer', value: BigInt(r.byte()) };
        break;
      case TAG.I8: {
        const b = r.byte();
        value = { type: 'integer', value: BigInt(b > 127 ? b - 256 : b) };
        break;
      }
      case TAG.Bytes:
        value = { type: 'bytes', value: Uint8Array.from(r.take(r.length())) };
        break;
      case TAG.Bytes20:
        value = { type: 'bytes', value: Uint8Array.from(r.take(20)) };
        break;
      case TAG.Bytes32:
        value = { type: 'bytes', value: Uint8Array.from(r.take(32)) };
        break;
      case TAG.Bytes36:
        value = { type: 'bytes', value: Uint8Array.from(r.take(36)) };
        break;
      case TAG.Identifier:
        value = { type: 'identifier', value: base58Encode(r.take(32)) };
        break;
      case TAG.Float: {
        const view = new DataView(Uint8Array.from(r.take(8)).buffer);
        value = { type: 'float', value: view.getFloat64(0, false) };
        break;
      }
      case TAG.Text:
        value = { type: 'text', value: utf8.decode(r.take(r.length())) };
        break;
      case TAG.Bool: {
        const b = r.byte();
        if (b > 1) throw new Error('invalid bool');
        value = { type: 'bool', value: b === 1 };
        break;
      }
      case TAG.Null:
        value = { type: 'null' };
        break;
      default:
        throw new Error('unsupported tag');
    }
    if (!r.done) throw new Error('trailing bytes');
    return value;
  } catch {
    return { type: 'raw', value: Uint8Array.from(bytes) };
  }
}

/** Coerce a wasm array element (Uint8Array, or a number[] after a copy). */
export function asBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw) && raw.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    return Uint8Array.from(raw as number[]);
  }
  return undefined;
}

// ---- plain JS values ---------------------------------------------------------

/**
 * Map a plain JS value (as `group.contestedResources` returns them: strings
 * for text fields) to an IndexValue. `hint` forces the type when the caller
 * knows the schema, e.g. an identifier field that came back as base58 text.
 */
export function indexValueFromJs(
  raw: unknown,
  hint?: 'identifier',
): IndexValue | undefined {
  if (hint === 'identifier') {
    if (typeof raw === 'string') return identifier(raw);
    const bytes = asBytes(raw);
    if (bytes && bytes.length === 32) return identifier(base58Encode(bytes));
    return undefined;
  }
  if (typeof raw === 'string') return text(raw);
  if (typeof raw === 'bigint') return { type: 'integer', value: raw };
  if (typeof raw === 'number') {
    return Number.isInteger(raw)
      ? { type: 'integer', value: BigInt(raw) }
      : { type: 'float', value: raw };
  }
  if (typeof raw === 'boolean') return { type: 'bool', value: raw };
  if (raw === null) return { type: 'null' };
  const bytes = asBytes(raw);
  if (bytes) return { type: 'bytes', value: Uint8Array.from(bytes) };
  return undefined;
}

/**
 * The JS value to pass in a query's `indexValues`. Identifiers go as base58
 * strings: the node refuses an Identifier object there (Yappr, verified on
 * 5.0 betas).
 */
export function toQueryValue(v: IndexValue): unknown {
  switch (v.type) {
    case 'integer':
      return v.value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        v.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v.value)
        : v.value;
    case 'null':
      return null;
    default:
      return v.value;
  }
}

/**
 * Whether `new VotePoll({ indexValues })` reproduces this value's exact type.
 * The constructor turns every JS string into Text, integers into U64 (a
 * schema integer is I64) and Uint8Arrays into an Array of U8, so only text,
 * bool and null survive. Anything else needs the poll object read from chain.
 */
export function isConstructible(v: IndexValue): boolean {
  return v.type === 'text' || v.type === 'bool' || v.type === 'null';
}

/** Short human rendering for titles and tables. */
export function displayIndexValue(v: IndexValue): string {
  switch (v.type) {
    case 'text':
    case 'identifier':
      return v.value;
    case 'integer':
      return v.value.toString();
    case 'float':
      return String(v.value);
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'bytes':
      return `0x${bytesToHex(v.value)}`;
    case 'raw':
      return `raw:0x${bytesToHex(v.value)}`;
  }
}

// ---- canonical JSON form (used inside the PollKey string) --------------------
//
// Text is a bare JSON string (so DPNS keys stay readable once decoded); every
// other type is a one-key object naming it.

export type IndexValueJson =
  | string
  | boolean
  | null
  | { id: string }
  | { int: string }
  | { f64: string }
  | { bytes: string }
  | { raw: string };

export function indexValueToJson(v: IndexValue): IndexValueJson {
  switch (v.type) {
    case 'text':
      return v.value;
    case 'identifier':
      return { id: v.value };
    case 'integer':
      return { int: v.value.toString() };
    case 'float': {
      // The IEEE-754 bits, big-endian: exact for -0, NaN and Infinity,
      // which JSON numbers cannot carry.
      const bits = new DataView(new ArrayBuffer(8));
      bits.setFloat64(0, v.value, false);
      return { f64: bytesToHex(new Uint8Array(bits.buffer)) };
    }
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'bytes':
      return { bytes: bytesToHex(v.value) };
    case 'raw':
      return { raw: bytesToHex(v.value) };
  }
}

const HEX = /^(?:[0-9a-f]{2})*$/;

/** Lowercase hex only: the canonical form must have one spelling per value. */
function hexBytes(hex: unknown): Uint8Array {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error('bad hex');
  return hexToBytes(hex);
}

/** Inverse of indexValueToJson. Throws on anything malformed. */
export function indexValueFromJson(j: unknown): IndexValue {
  if (typeof j === 'string') return text(j);
  if (typeof j === 'boolean') return { type: 'bool', value: j };
  if (j === null) return { type: 'null' };
  if (typeof j !== 'object' || Array.isArray(j)) throw new Error('bad index value');
  const entries = Object.entries(j as Record<string, unknown>);
  if (entries.length !== 1) throw new Error('bad index value');
  const [kind, value] = entries[0];
  switch (kind) {
    case 'id':
      if (typeof value !== 'string' || base58Decode(value).length !== 32) {
        throw new Error('bad identifier');
      }
      return identifier(value);
    case 'int':
      if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('bad int');
      return { type: 'integer', value: BigInt(value) };
    case 'f64': {
      const bytes = hexBytes(value);
      if (bytes.length !== 8) throw new Error('bad float');
      return { type: 'float', value: new DataView(bytes.buffer).getFloat64(0, false) };
    }
    case 'bytes':
      return { type: 'bytes', value: hexBytes(value) };
    case 'raw':
      return { type: 'raw', value: hexBytes(value) };
    default:
      throw new Error('bad index value');
  }
}
