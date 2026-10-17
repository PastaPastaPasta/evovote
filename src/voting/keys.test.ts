import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode, hexToBytes } from '../model/bytes';
import { voterKeyMatches } from './keyring';
import { isProTxHash, p2pkhAddress, voterIdentityId, wifNetwork } from './keys';

describe('base58', () => {
  it('should round-trip arbitrary bytes', () => {
    const bytes = Uint8Array.from([255, 0, 128, 7, 42, 200, 1]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('should preserve leading zero bytes as leading 1s', () => {
    const bytes = Uint8Array.from([0, 0, 5, 17]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('should reject invalid base58 characters', () => {
    expect(() => base58Decode('0OIl')).toThrow();
  });
});

describe('hexToBytes', () => {
  it('should decode hex', () => {
    expect(hexToBytes('00ff10')).toEqual(Uint8Array.from([0, 255, 16]));
  });

  it('should reject odd-length and non-hex input', () => {
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });
});

describe('p2pkhAddress', () => {
  // Vector verified against @dashevo/evo-sdk's own key derivation on mainnet.
  it('should derive the mainnet address for a known pubkey hash', async () => {
    const address = await p2pkhAddress(
      'bb79232540011a48da61de549b9ac58b346c39ae',
      'mainnet',
    );
    expect(address).toBe('Xsn7JtgzfUzgEXxbSr4RjqCcx8qjyp38gg');
  });

  it('should reject a hash that is not 20 bytes', async () => {
    await expect(p2pkhAddress('abcd', 'mainnet')).rejects.toThrow();
  });
});

function syntheticWif(version: number, length: 37 | 38 = 38): string {
  const bytes = new Uint8Array(length);
  bytes[0] = version;
  bytes.fill(7, 1);
  return base58Encode(bytes);
}

describe('wifNetwork', () => {
  it('should detect mainnet (0xCC) and testnet (0xEF) version bytes', () => {
    expect(wifNetwork(syntheticWif(0xcc))).toBe('mainnet');
    expect(wifNetwork(syntheticWif(0xef))).toBe('testnet');
    expect(wifNetwork(syntheticWif(0xcc, 37))).toBe('mainnet');
  });

  it('should return undefined for foreign versions, bad lengths, and garbage', () => {
    expect(wifNetwork(syntheticWif(0x80))).toBeUndefined(); // Bitcoin WIF
    expect(wifNetwork(base58Encode(new Uint8Array(10)))).toBeUndefined();
    expect(wifNetwork('not-a-wif-0OIl')).toBeUndefined();
    expect(wifNetwork('')).toBeUndefined();
  });
});

describe('isProTxHash', () => {
  it('should accept 64 hex chars and reject anything else', () => {
    expect(isProTxHash('a'.repeat(64))).toBe(true);
    expect(isProTxHash('A9'.repeat(32))).toBe(true);
    expect(isProTxHash('a'.repeat(63))).toBe(false);
    expect(isProTxHash('g'.repeat(64))).toBe(false);
    expect(isProTxHash('')).toBe(false);
  });
});

describe('voterIdentityId', () => {
  // Testnet evonodes: the derived ids exist on Platform with key 0 matching
  // the ProRegTx voting key hash (docs/V2_NOTES.md, 2026-10-17).
  it('should derive SHA256(proTxHash ‖ votingKeyHash160) in Core display order', async () => {
    await expect(
      voterIdentityId(
        'f37de98bcd094e33307c6705204bccdf4d7ad10eb08999c1c9281847b5ef22b0',
        'c88818ac93c56d21cb72c3255e3de33d160674d3',
      ),
    ).resolves.toBe('hC53djK5X6R9C18FxF4U1nxfJW2eFuevudHWRYFJXow');
    await expect(
      voterIdentityId(
        'f647566c779b1a91f7c9d1869019c29a0171df7d368d96a3c4fad84d742bbe49',
        'd1769a7dd51d17aebb64a38e69042d5aa50a7d31',
      ),
    ).resolves.toBe('596BJxM4nZankD3KQuvEBhzD7RfCErbYaX7CV7hJexAP');
  });

  it('should reject inputs of the wrong length', async () => {
    await expect(voterIdentityId('ab', 'c88818ac93c56d21cb72c3255e3de33d160674d3')).rejects.toThrow();
    await expect(voterIdentityId('a'.repeat(64), 'abcd')).rejects.toThrow();
  });
});

describe('voterKeyMatches', () => {
  const hash = 'c88818ac93c56d21cb72c3255e3de33d160674d3';
  // toJSON() of the voter identity's key 0 on testnet.
  const key0 = { purpose: 5, data: 'yIgYrJPFbSHLcsMlXj3jPRYGdNM=' };

  it('should accept an enabled VOTING key over the hash', () => {
    expect(voterKeyMatches(key0, hash)).toBe(true);
    expect(voterKeyMatches({ ...key0, disabledAt: null }, hash)).toBe(true);
  });

  it('should reject another hash, another purpose, a disabled key, or none', () => {
    expect(voterKeyMatches(key0, 'd1769a7dd51d17aebb64a38e69042d5aa50a7d31')).toBe(false);
    expect(voterKeyMatches({ ...key0, purpose: 0 }, hash)).toBe(false);
    expect(voterKeyMatches({ ...key0, disabledAt: '1700000000000' }, hash)).toBe(false);
    expect(voterKeyMatches(undefined, hash)).toBe(false);
  });
});
