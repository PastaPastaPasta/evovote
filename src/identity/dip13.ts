/**
 * DIP-13 identity authentication keys from a recovery phrase, derived the way
 * Dash Wallet does (dashwallet-ios #1210 -> swift-sdk -> rs-platform-wallet ->
 * rust-dashcore key-wallet `dip9.rs`):
 *
 *   identity auth key:   m/9'/coin'/5'/0'/0'/identity_index'/key_index'
 *
 * coin is 5' on mainnet and 1' elsewhere; the wallet registers each key at
 * key_index = its key id. The derivation runs on wasm-sdk's
 * `deriveKeyFromSeedWithExtendedPath`, pinned by vectors in dip13.test.ts.
 *
 * Adapted from Yappr's lib/crypto/dip13.ts
 * (https://github.com/PastaPastaPasta/yappr, MIT), trimmed to the
 * authentication-key path EvoVote uses.
 */
import type { Network } from '../sdk/network';

/** Consecutive unused identity indexes after which a scan stops (rs-platform-wallet `IDENTITY_GAP_LIMIT`). */
export const IDENTITY_GAP_LIMIT = 5;

/** Key index 0 of every wallet identity is its MASTER authentication key, the one a scan looks up. */
export const MASTER_KEY_INDEX = 0;

const coinType = (network: Network): number => (network === 'mainnet' ? 5 : 1);

function hardened(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error(`Invalid derivation index ${index}`);
  return `${index}'`;
}

/** `m/9'/coin'/5'/0'/0'/identity_index'/key_index'`: an ECDSA identity authentication key. */
export function identityAuthKeyPath(network: Network, identityIndex: number, keyIndex: number): string {
  return `m/9'/${coinType(network)}'/5'/0'/0'/${hardened(identityIndex)}/${hardened(keyIndex)}`;
}

/** A recovery phrase as BIP-39 reads it: lower case, single spaces, no padding. */
export function normalizeRecoveryPhrase(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export interface Dip13Key {
  privateKey: Uint8Array;
  /** 33-byte compressed secp256k1 point. */
  publicKey: Uint8Array;
}

/** The wasm-sdk statics the derivation runs on (`mod.WasmSdk`, once the SDK is initialised). */
export interface Dip13Wasm {
  validateMnemonic(mnemonic: string, languageCode?: string | null): boolean;
  deriveKeyFromSeedWithExtendedPath(params: { mnemonic: string; path: string; network: string }): {
    privateKeyHex: string;
    publicKey: string;
    free?: () => void;
  };
}

function fromHex(hex: unknown, length: number, what: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length !== length * 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`The derivation returned no ${what}`);
  }
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The phrase is not a BIP-39 English phrase with a valid checksum (as opposed to the SDK failing). */
export class InvalidPhraseError extends Error {
  constructor() {
    super('Invalid recovery phrase');
    this.name = 'InvalidPhraseError';
  }
}

/**
 * A key-deriving handle for one phrase (empty BIP-39 passphrase, as Dash
 * Wallet uses). The phrase stays inside the closure; callers drop the handle
 * when done. Every key comes back as fresh bytes the caller zeroes. Wiping is
 * best effort: the SDK hands keys over as hex strings, and JS strings (the
 * phrase among them) cannot be zeroed.
 */
export interface Dip13Wallet {
  derive(path: string): Dip13Key;
}

export function dip13Wallet(sdk: Dip13Wasm, input: string, network: Network): Dip13Wallet {
  // BIP-39 word lookup is case-sensitive: read the phrase as a wallet does.
  const phrase = normalizeRecoveryPhrase(input);
  if (!sdk.validateMnemonic(phrase, 'en')) throw new InvalidPhraseError();
  return {
    derive(path) {
      const result = sdk.deriveKeyFromSeedWithExtendedPath({ mnemonic: phrase, path, network });
      try {
        // Read the two fields directly: toJSON() would copy every field (WIF and xprv included) into another object.
        return { privateKey: fromHex(result.privateKeyHex, 32, 'private key'), publicKey: fromHex(result.publicKey, 33, 'public key') };
      } finally {
        result.free?.();
      }
    },
  };
}
