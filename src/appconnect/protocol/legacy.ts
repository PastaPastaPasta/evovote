import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The six helpers the App Connect core imports from platform-auth's legacy
 * key-exchange module (`key-exchange/yappr-protocol.ts`), copied verbatim
 * from Yappr staging c7fd2665 with the `YapprKeyExchangeNetworkName` type
 * from `core/types.ts`. Names are kept so the core files stay byte-identical.
 */

export type YapprKeyExchangeNetworkName = 'testnet' | 'mainnet' | 'devnet'

const encoder = new TextEncoder()
const NO_HKDF_INFO = new Uint8Array(0)

export const YAPPR_NETWORK_IDS = {
  mainnet: 'm',
  testnet: 't',
  devnet: 'd',
} as const

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

/**
 * ECDH x-coordinate → HKDF-SHA256 (salt `dash:key-exchange:v1`). ECDH is
 * symmetric, so the wallet calls this with its private key and the app's
 * public key. The legacy key exchange uses an empty `info`; App Connect v2
 * passes `app-connect:v2`.
 */
export function deriveYapprSharedSecret(
  appEphemeralPrivateKey: Uint8Array,
  walletEphemeralPublicKey: Uint8Array,
  info: Uint8Array = NO_HKDF_INFO,
): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(appEphemeralPrivateKey, walletEphemeralPublicKey)
  const sharedX = sharedPoint.slice(1, 33)
  try {
    return hkdf(
      sha256,
      sharedX,
      encoder.encode('dash:key-exchange:v1'),
      info,
      32,
    )
  } finally {
    sharedX.fill(0)
    sharedPoint.fill(0)
  }
}

export function getYapprPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true)
}

export function clearSensitiveBytes(bytes: Uint8Array): void {
  bytes.fill(0)
}

export function decodeYapprIdentityId(identityIdBase58: string): Uint8Array {
  const decoded = bs58.decode(identityIdBase58)
  if (decoded.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${decoded.length}`)
  }
  return decoded
}
