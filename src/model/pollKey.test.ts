import { describe, expect, it } from 'vitest';
import { base58Encode } from './bytes';
import { decodePollKey, encodePollKey, pollKeyFromSdkPoll, pollKeysEqual, type PollKey } from './pollKey';

const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const CHARTERS = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';

const dpnsKey: PollKey = {
  contractId: DPNS,
  documentTypeName: 'domain',
  indexName: 'parentNameAndLabel',
  indexValues: [
    { type: 'text', value: 'dash' },
    { type: 'text', value: 'ther0adn0ttaken' },
  ],
};

const charterKey: PollKey = {
  contractId: CHARTERS,
  documentTypeName: 'electedCharter',
  indexName: 'byTargetContract',
  indexValues: [{ type: 'identifier', value: DPNS }],
};

describe('PollKey canonical string', () => {
  it('should round-trip text and identifier keys', () => {
    for (const key of [dpnsKey, charterKey]) {
      const encoded = encodePollKey(key);
      expect(decodePollKey(encoded)).toEqual(key);
    }
  });

  it('should round-trip every value type', () => {
    const key: PollKey = {
      contractId: DPNS,
      documentTypeName: 'odd type',
      indexName: 'idx/with/slashes',
      indexValues: [
        { type: 'integer', value: -42n },
        { type: 'float', value: 0.5 },
        { type: 'bytes', value: Uint8Array.from([1, 2]) },
        { type: 'bool', value: true },
        { type: 'null' },
        { type: 'raw', value: Uint8Array.from([0x15, 0]) },
        { type: 'text', value: 'ünïcødé ✓' },
      ],
    };
    const encoded = encodePollKey(key);
    expect(encoded.split('/')).toHaveLength(4);
    expect(decodePollKey(encoded)).toEqual(key);
  });

  it('should be deterministic and distinguish value types', () => {
    expect(encodePollKey(dpnsKey)).toBe(encodePollKey({ ...dpnsKey }));
    const asText: PollKey = { ...charterKey, indexValues: [{ type: 'text', value: DPNS }] };
    expect(pollKeysEqual(asText, charterKey)).toBe(false);
  });

  it('should be URL-safe (no +, = or unescaped specials in the values segment)', () => {
    const values = encodePollKey(dpnsKey).split('/')[3];
    expect(values).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should reject malformed strings', () => {
    for (const bad of ['', 'a/b/c', 'a/b/c/d/e', `${DPNS}/domain/x/!!!`, `${DPNS}/domain/x/e30`, `/domain/x/W10`]) {
      expect(decodePollKey(bad)).toBeUndefined();
    }
  });
});

describe('pollKeyFromSdkPoll', () => {
  it('should decode the bincode index values a chain poll carries', () => {
    const text = (s: string) => {
      const utf8 = new TextEncoder().encode(s);
      return Uint8Array.from([0x12, utf8.length, ...utf8]);
    };
    const key = pollKeyFromSdkPoll({
      contractId: { toBase58: () => DPNS },
      documentTypeName: 'domain',
      indexName: 'parentNameAndLabel',
      indexValues: [text('dash'), Array.from(text('ther0adn0ttaken'))],
    });
    expect(key).toEqual(dpnsKey);
  });

  it('should keep an Identifier value typed', () => {
    const id = new Uint8Array(32).fill(5);
    const key = pollKeyFromSdkPoll({
      contractId: CHARTERS,
      documentTypeName: 'electedCharter',
      indexName: 'byTargetContract',
      indexValues: [Uint8Array.from([0x10, ...id])],
    });
    expect(key.indexValues).toEqual([{ type: 'identifier', value: base58Encode(id) }]);
  });
});
