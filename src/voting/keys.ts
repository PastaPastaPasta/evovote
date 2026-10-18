import type { Network } from '../sdk/network';
import { base58Decode, base58Encode, hexToBytes, sha256 } from '../model/bytes';

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

/**
 * The Platform identity a masternode votes as:
 * `SHA256(proTxHash ‖ HASH160(voting pubkey))`, single SHA-256 (rs-dpp
 * `create_voter_identifier`). `proTxHash` is the hex Core RPC displays, used
 * in that byte order (not reversed). Verified on testnet: every enabled
 * masternode's derived id exists with key 0 = VOTING/HIGH/ECDSA_HASH160 over
 * that hash160 (docs/V2_NOTES.md).
 */
export async function voterIdentityId(
  proTxHashHex: string,
  votingKeyHash160Hex: string,
): Promise<string> {
  const proTx = hexToBytes(proTxHashHex);
  const hash160 = hexToBytes(votingKeyHash160Hex);
  if (proTx.length !== 32) throw new Error('ProTxHash must be 32 bytes');
  if (hash160.length !== 20) throw new Error('Voting key hash must be 20 bytes');
  const pre = new Uint8Array(52);
  pre.set(proTx, 0);
  pre.set(hash160, 32);
  return base58Encode(await sha256(pre));
}
