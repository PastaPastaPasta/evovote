// Wire protocol reused from PastaPastaPasta/platform-auth (MIT),
// src/key-exchange/yappr-protocol.ts. Keep compatible with Yappr wallets.
import * as secp256k1 from '@noble/secp256k1';
import { hkdf } from '@noble/hashes/hkdf.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, base58Encode } from './keys';
import type { Network, SdkHandle } from './sdk';

const encoder = new TextEncoder();
export const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));
export const stateTransitionUri = (bytes: Uint8Array, network: Network): string =>
  `dash-st:${base58Encode(bytes)}?n=${network === 'mainnet' ? 'm' : 't'}&v=1`;

/** SDK properties can expose byte arrays as Uint8Array or numeric arrays. */
export function platformBytes(value: unknown, length: number): Uint8Array {
  const entries = value instanceof Uint8Array ? Array.from(value) : value;
  if (!Array.isArray(entries) || entries.length !== length || !entries.every(byte =>
    (typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
    (typeof byte === 'bigint' && byte >= 0n && byte <= 255n))) {
    throw new Error('Invalid binary field from Platform.');
  }
  return Uint8Array.from(entries, Number);
}

export function identifierBytes(id: string): Uint8Array {
  const bytes = base58Decode(id);
  if (bytes.length !== 32) throw new Error('Expected a 32-byte Platform identifier.');
  return bytes;
}

export function walletLoginRequest(contractId: string, network: Network) {
  const secret = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(secret, true);
  const label = encoder.encode('Login to EvoVote');
  const payload = new Uint8Array(67 + label.length);
  payload[0] = 1;
  payload.set(publicKey, 1);
  payload.set(identifierBytes(contractId), 34);
  payload[66] = label.length;
  payload.set(label, 67);
  return {
    secret,
    publicKeyHash: hash160(publicKey),
    uri: `dash-key:${base58Encode(payload)}?n=${network === 'mainnet' ? 'm' : 't'}&v=1`,
  };
}

/** Use Document.toObject(): byte arrays are bytes, never guessed base64/hex. */
export async function checkWalletLogin(
  { sdk }: SdkHandle,
  exchangeId: string,
  contractId: string,
  request: ReturnType<typeof walletLoginRequest>,
): Promise<string | undefined> {
  const documents = await sdk.documents.query({
    dataContractId: exchangeId,
    documentTypeName: 'loginKeyResponse',
    where: [
      ['contractId', '==', contractId],
      // Raw document queries use base64 for ordinary byte-array operands.
      ['appEphemeralPubKeyHash', '==', btoa(String.fromCharCode(...request.publicKeyHash))],
    ],
    limit: 1,
  });
  for (const doc of documents.values()) {
    if (!doc) continue;
    try {
      const data = doc.toObject();
      const pub = platformBytes(data.walletEphemeralPubKey, 33);
      const payload = platformBytes(data.encryptedPayload, 60);
      const point = secp256k1.getSharedSecret(request.secret, pub);
      const shared = hkdf(sha256, point.slice(1, 33), encoder.encode('dash:key-exchange:v1'), new Uint8Array(), 32);
      point.fill(0);
      try {
        const key = await crypto.subtle.importKey('raw', shared as BufferSource, 'AES-GCM', false, ['decrypt']);
        const loginKey = new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: payload.slice(0, 12) }, key, payload.slice(12),
        ));
        // The wallet publishes this response under its own Platform identity.
        // EvoVote discards the login secret: each write is signed in the wallet.
        const valid = loginKey.length === 32;
        loginKey.fill(0);
        if (!valid) throw new Error('Invalid wallet response.');
        return doc.ownerId.toString();
      } finally {
        shared.fill(0);
      }
    } finally {
      doc.free();
    }
  }
}
