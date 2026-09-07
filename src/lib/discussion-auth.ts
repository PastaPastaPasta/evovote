import type { IdentityPublicKey, PrivateKey } from '@dashevo/evo-sdk';
import { wifNetwork } from './keys';
import type { Network, SdkHandle } from './sdk';

export interface DiscussionSession {
  identityId: string;
  mode: 'wallet' | 'key';
  privateKey?: PrivateKey;
  keyId: number;
}

export function usableAuthKey(key: IdentityPublicKey): boolean {
  return key.purposeNumber === 0 && [1, 2].includes(key.securityLevelNumber) &&
    [0, 2].includes(key.keyTypeNumber) && key.disabledAt == null &&
    !key.contractBounds;
}

export async function walletSession(handle: SdkHandle, identityId: string): Promise<DiscussionSession> {
  const identity = await handle.sdk.identities.fetch(identityId);
  if (!identity) throw new Error('The wallet identity could not be found.');
  const keys = identity.publicKeys;
  try {
    const key = keys.filter(usableAuthKey).sort((a, b) => b.securityLevelNumber - a.securityLevelNumber)[0];
    if (!key) throw new Error('This identity needs an active HIGH or CRITICAL authentication key.');
    return { identityId, mode: 'wallet', keyId: key.keyId };
  } finally {
    keys.forEach(key => key.free());
    identity.free();
  }
}

/** Only the public key hash leaves the browser. No identity ID input required. */
export async function loginWithKey(handle: SdkHandle, network: Network, input: string): Promise<DiscussionSession[]> {
  const text = input.trim();
  const isHex = /^(?:0x)?[0-9a-fA-F]{64}$/.test(text);
  if (!isHex && wifNetwork(text) !== network) throw new Error('Enter an authentication key for the selected network.');
  let key: PrivateKey;
  try {
    key = isHex ? handle.mod.PrivateKey.fromHex(text.replace(/^0x/, ''), network) : handle.mod.PrivateKey.fromWIF(text);
  } catch {
    throw new Error('Invalid authentication private key. Use 32-byte hex or Dash WIF.');
  }
  const sessions: DiscussionSession[] = [];
  try {
    const hash = key.getPublicKeyHash();
    const unique = await handle.sdk.identities.byPublicKeyHash(hash);
    const identities = unique ? [unique] : await handle.sdk.identities.byNonUniquePublicKeyHash(hash);
    for (const identity of identities) {
      const keys = identity.publicKeys;
      try {
        const match = keys.find(candidate => usableAuthKey(candidate) && candidate.getPublicKeyHash() === hash);
        if (match) sessions.push({ identityId: identity.id.toString(), mode: 'key', keyId: match.keyId, privateKey: key });
      } finally {
        keys.forEach(candidate => candidate.free());
        identity.free();
      }
    }
    if (!sessions.length) throw new Error('No identity with an active HIGH or CRITICAL authentication key matches.');
    return sessions;
  } catch (error) {
    key.free();
    throw error;
  }
}
