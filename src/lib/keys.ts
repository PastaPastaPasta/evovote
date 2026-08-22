import type { Network } from './sdk';

const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const index = B58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base58 character "${char}"`);
    value = value * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Dash address / WIF version bytes.
const P2PKH_VERSION: Record<Network, number> = { mainnet: 0x4c, testnet: 0x8c };
const WIF_VERSION: Record<Network, number> = { mainnet: 0xcc, testnet: 0xef };

/** Base58check P2PKH address for a HASH160(pubkey), i.e. a Core voting address. */
export async function p2pkhAddress(
  pubKeyHashHex: string,
  network: Network,
): Promise<string> {
  const hash = hexToBytes(pubKeyHashHex);
  if (hash.length !== 20) throw new Error('Public key hash must be 20 bytes');
  const payload = new Uint8Array(21);
  payload[0] = P2PKH_VERSION[network];
  payload.set(hash, 1);
  const checksum = (await sha256(await sha256(payload))).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(checksum, 21);
  return base58Encode(full);
}

/**
 * Which network a WIF belongs to, from its version byte.
 * Returns undefined for anything that doesn't decode to a Dash WIF.
 */
export function wifNetwork(wif: string): Network | undefined {
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(wif.trim());
  } catch {
    return undefined;
  }
  // version + 32-byte key [+ 0x01 compressed flag] + 4-byte checksum
  if (decoded.length !== 37 && decoded.length !== 38) return undefined;
  if (decoded[0] === WIF_VERSION.mainnet) return 'mainnet';
  if (decoded[0] === WIF_VERSION.testnet) return 'testnet';
  return undefined;
}

export function isProTxHash(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}
