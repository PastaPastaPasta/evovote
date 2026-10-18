import type { BoundKeySpec } from '../identity/update';
import { CHARTERS_CONTRACT_ID } from './documents';

/** The leader's key join requests are encrypted to (`joinRequest.recipientId` keyRequirements). */
export const CHARTER_DECRYPTION: BoundKeySpec = {
  purpose: 'DECRYPTION',
  contractId: CHARTERS_CONTRACT_ID,
  documentTypeName: 'submittedCharter',
};

/** A member's key its join request is encrypted with (`joinRequest.senderKeyId` keyRequirements). */
export const JOIN_ENCRYPTION: BoundKeySpec = {
  purpose: 'ENCRYPTION',
  contractId: CHARTERS_CONTRACT_ID,
  documentTypeName: 'joinRequest',
};

/** The size of an `ecdh-secp256k1-aes256-cbc` ciphertext: a 16-byte IV, then PKCS#7-padded blocks. */
export function encryptedSize(plaintextBytes: number): number {
  return 16 + (Math.floor(plaintextBytes / 16) + 1) * 16;
}
