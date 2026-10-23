import * as mod from '@dashevo/evo-sdk';
import * as secp256k1 from '@noble/secp256k1';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../model/bytes';
import { dip13Wallet, identityAuthKeyPath, InvalidPhraseError, normalizeRecoveryPhrase } from './dip13';

/**
 * BIP-39's all-zero-entropy phrase: a public test mnemonic, never a real
 * wallet's. The vectors are Yappr's pinned one (lib/crypto/dip13.test.ts:
 * testnet identity 0, key 0) and others computed with an independent BIP-32
 * (@scure/bip32 + @scure/bip39) on the same paths.
 */
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const VECTORS: Array<['testnet' | 'mainnet', number, number, string]> = [
  ['testnet', 0, 0, '03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db'],
  ['testnet', 0, 1, '03280859fd14d1b8a7a75d918dd0a1bf922be5af7eff9aafa26f446ea5f16da616'],
  ['testnet', 0, 2, '02cb109b54e542efbb86f3e5ba1d6a2da97d02cc4de0c706c23ab8ddb53ff7fe3e'],
  ['testnet', 1, 0, '0312aa9ac813f9751da6747c4ac7798a9c5f778545788204785eafbfe287544144'],
  ['testnet', 1, 1, '03a8150f657be60fe91fec7aefe69d655247417e9e7ab408d209261b57f798ce84'],
  ['mainnet', 0, 0, '03de6e4f0a455c1f089e51c53ed937b172d46e5cec4a98e2d9977ea4638129d252'],
  ['mainnet', 0, 1, '02725184a963a31b362742455e4b1bd36b8b56b0d667f1f6c24688ed3d9b0e13e9'],
];

beforeAll(async () => {
  await mod.ensureInitialized();
});

describe('DIP-13 identity key paths', () => {
  it('match the strings key-wallet builds (dip9.rs)', () => {
    expect(identityAuthKeyPath('mainnet', 1, 2)).toBe("m/9'/5'/5'/0'/0'/1'/2'");
    expect(identityAuthKeyPath('testnet', 2, 3)).toBe("m/9'/1'/5'/0'/0'/2'/3'");
  });

  it('refuse indexes out of range', () => {
    expect(() => identityAuthKeyPath('testnet', -1, 0)).toThrow();
    expect(() => identityAuthKeyPath('testnet', 0, 0x80000000)).toThrow();
    expect(() => identityAuthKeyPath('testnet', 0.5, 0)).toThrow();
  });
});

describe('DIP-13 keys from a recovery phrase', () => {
  it('reproduce the pinned vectors byte for byte', () => {
    for (const [network, identityIndex, keyIndex, publicKey] of VECTORS) {
      const wallet = dip13Wallet(mod.WasmSdk, TEST_PHRASE, network);
      expect(bytesToHex(wallet.derive(identityAuthKeyPath(network, identityIndex, keyIndex)).publicKey)).toBe(publicKey);
    }
  });

  it('return a private key whose point is the public key', () => {
    const key = dip13Wallet(mod.WasmSdk, TEST_PHRASE, 'testnet').derive(identityAuthKeyPath('testnet', 1, 1));
    expect(bytesToHex(secp256k1.getPublicKey(key.privateKey, true))).toBe(bytesToHex(key.publicKey));
  });

  it('read a mixed-case, oddly spaced phrase as the wallet does', () => {
    const typed = `  ${TEST_PHRASE.toUpperCase().split(' ').join('\t ')}\n`;
    const path = identityAuthKeyPath('testnet', 0, 2);
    expect(bytesToHex(dip13Wallet(mod.WasmSdk, typed, 'testnet').derive(path).publicKey)).toBe(VECTORS[2][3]);
  });

  it('refuse a phrase whose checksum fails', () => {
    const broken = TEST_PHRASE.replace(/about$/, 'abandon');
    expect(() => dip13Wallet(mod.WasmSdk, broken, 'testnet')).toThrow(InvalidPhraseError);
  });
});

describe('normalizeRecoveryPhrase', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(normalizeRecoveryPhrase('  Abandon\tABANDON\n about  ')).toBe('abandon abandon about');
    expect(normalizeRecoveryPhrase('   ')).toBe('');
  });
});
