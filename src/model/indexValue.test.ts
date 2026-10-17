import { describe, expect, it } from 'vitest';
import { base58Encode } from './bytes';
import {
  decodeBincodeValue,
  displayIndexValue,
  indexValueFromJs,
  indexValueFromJson,
  indexValueToJson,
  isConstructible,
  toQueryValue,
  type IndexValue,
} from './indexValue';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe('decodeBincodeValue', () => {
  // Vectors produced by rc.4's own `new VotePoll({ indexValues }).indexValues`
  // (bincode standard, big-endian), see docs/V2_NOTES.md.
  it('should decode text, including a long (u16-length) string', () => {
    expect(decodeBincodeValue(hex('120464617368'))).toEqual({ type: 'text', value: 'dash' });
    const long = decodeBincodeValue(hex('12fb012c' + '61'.repeat(300)));
    expect(long).toEqual({ type: 'text', value: 'a'.repeat(300) });
  });

  it('should decode unsigned and zigzag signed varint integers', () => {
    expect(decodeBincodeValue(hex('0205'))).toEqual({ type: 'integer', value: 5n });
    expect(decodeBincodeValue(hex('0305'))).toEqual({ type: 'integer', value: -3n });
    expect(decodeBincodeValue(hex('02fb012c'))).toEqual({ type: 'integer', value: 300n });
    expect(decodeBincodeValue(hex('02fc00011170'))).toEqual({ type: 'integer', value: 70000n });
    expect(decodeBincodeValue(hex('02fd0000010000000000'))).toEqual({
      type: 'integer',
      value: 2n ** 40n,
    });
    expect(decodeBincodeValue(hex('08ff'))).toEqual({ type: 'integer', value: 255n }); // U8
    expect(decodeBincodeValue(hex('09ff'))).toEqual({ type: 'integer', value: -1n }); // I8
  });

  it('should decode floats, bools and null', () => {
    expect(decodeBincodeValue(hex('113ff8000000000000'))).toEqual({ type: 'float', value: 1.5 });
    expect(decodeBincodeValue(hex('1301'))).toEqual({ type: 'bool', value: true });
    expect(decodeBincodeValue(hex('1300'))).toEqual({ type: 'bool', value: false });
    expect(decodeBincodeValue(hex('14'))).toEqual({ type: 'null' });
  });

  it('should decode an Identifier (tag 0x10) as base58', () => {
    const id = new Uint8Array(32).fill(9);
    const bytes = Uint8Array.from([0x10, ...id]);
    expect(decodeBincodeValue(bytes)).toEqual({ type: 'identifier', value: base58Encode(id) });
  });

  it('should decode Bytes and fixed-size byte arrays', () => {
    expect(decodeBincodeValue(hex('0a03010203'))).toEqual({
      type: 'bytes',
      value: Uint8Array.from([1, 2, 3]),
    });
    const b32 = new Uint8Array(32).fill(7);
    expect(decodeBincodeValue(Uint8Array.from([0x0c, ...b32]))).toEqual({ type: 'bytes', value: b32 });
  });

  it('should fall back to raw for arrays, garbage, truncation and trailing bytes', () => {
    for (const h of ['1503020102020203', 'ff', '1205616263', '12026162ff', '', '1302']) {
      const bytes = h ? hex(h) : new Uint8Array();
      expect(decodeBincodeValue(bytes)).toEqual({ type: 'raw', value: bytes });
    }
  });

  it('should reject invalid UTF-8 text as raw', () => {
    expect(decodeBincodeValue(hex('1202fffe')).type).toBe('raw');
  });
});

describe('index value JSON form', () => {
  const values: IndexValue[] = [
    { type: 'text', value: 'dash' },
    { type: 'identifier', value: base58Encode(new Uint8Array(32).fill(3)) },
    { type: 'integer', value: -12345678901234567890n },
    { type: 'float', value: 2.25 },
    { type: 'bytes', value: Uint8Array.from([0, 255]) },
    { type: 'bool', value: false },
    { type: 'null' },
    { type: 'raw', value: Uint8Array.from([0x15, 0]) },
  ];

  it('should round-trip every type', () => {
    for (const v of values) {
      expect(indexValueFromJson(JSON.parse(JSON.stringify(indexValueToJson(v))))).toEqual(v);
    }
  });

  it('should keep text as a bare string', () => {
    expect(indexValueToJson({ type: 'text', value: 'alice' })).toBe('alice');
  });

  it('should reject malformed JSON values', () => {
    for (const bad of [{ id: 'notbase58!' }, { id: '1111' }, { int: '1.5' }, { bytes: 'abc' }, { x: 1 }, [1], 3, { id: 'a', int: '1' }]) {
      expect(() => indexValueFromJson(bad)).toThrow();
    }
  });
});

describe('query and construction helpers', () => {
  it('should pass identifiers to queries as base58 strings', () => {
    expect(toQueryValue({ type: 'identifier', value: 'abc' })).toBe('abc');
    expect(toQueryValue({ type: 'integer', value: 7n })).toBe(7);
    expect(toQueryValue({ type: 'integer', value: 2n ** 60n })).toBe(2n ** 60n);
  });

  it('should only treat text, bool and null as constructible', () => {
    expect(isConstructible({ type: 'text', value: 'a' })).toBe(true);
    expect(isConstructible({ type: 'identifier', value: 'a' })).toBe(false);
    expect(isConstructible({ type: 'integer', value: 1n })).toBe(false);
    expect(isConstructible({ type: 'bytes', value: new Uint8Array() })).toBe(false);
  });

  it('should map plain JS values, honouring an identifier hint', () => {
    expect(indexValueFromJs('dash')).toEqual({ type: 'text', value: 'dash' });
    expect(indexValueFromJs('abc', 'identifier')).toEqual({ type: 'identifier', value: 'abc' });
    const id = new Uint8Array(32).fill(1);
    expect(indexValueFromJs(id, 'identifier')).toEqual({ type: 'identifier', value: base58Encode(id) });
    expect(indexValueFromJs(3)).toEqual({ type: 'integer', value: 3n });
    expect(indexValueFromJs({})).toBeUndefined();
  });

  it('should render values for display', () => {
    expect(displayIndexValue({ type: 'bytes', value: Uint8Array.from([1, 171]) })).toBe('0x01ab');
    expect(displayIndexValue({ type: 'integer', value: -2n })).toBe('-2');
  });
});
