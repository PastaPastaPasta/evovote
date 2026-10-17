import { useSyncExternalStore } from 'react';
import { bytesToHex } from '../model/bytes';
import { loadSdk, type SdkHandle } from '../sdk/connection';
import { errorMessage } from '../sdk/errors';
import { freeQuietly } from '../sdk/free';
import type { Network } from '../sdk/network';
import { wifNetwork } from '../voting/keys';
import { canSignDocumentsFor, isMasterKey, keyInfoFrom, keyMatching, type KeyInfo } from './keys';

/**
 * The identity session (`#/me`): sign in by pasting a private key (WIF).
 *
 * - The identity is found by the key's public-key hash: first the unique
 *   index (ECDSA_SECP256K1 keys), then the non-unique one (ECDSA_HASH160).
 * - Private keys live only in this module's memory and vanish with the tab.
 *   Nothing is persisted, logged or sent anywhere; only the SDK signs with them.
 * - A MASTER key is refused for sign-in: it is asked for just in time by the
 *   one write that needs it (adding a key) and dropped right after.
 *
 * WP4 (discussions) and the charter flows use the same API:
 * `useIdentitySession()` for the view, `withDocumentSigner()` to sign a
 * document write, `refreshIdentity()` after a write.
 */
export interface IdentitySession {
  network: Network;
  identityId: string;
  /** DPNS names (best effort; empty when none or unreadable). */
  names: string[];
  /** Credits (1 DASH = 1e11). */
  balance: bigint;
  revision: bigint;
  keys: KeyInfo[];
  /** The identity key the pasted private key belongs to. */
  loginKey: KeyInfo;
}

export type SignInResult =
  | { ok: true }
  | { ok: false; error: string }
  /** The key hash is shared by several identities: pick one and sign in again. */
  | { ok: false; choose: string[] };

let session: IdentitySession | null = null;
let loginWif: string | null = null;
/** Extra private keys (hex) held for this session, by HASH160 of their public key. */
const heldKeys = new Map<string, string>();
const listeners = new Set<() => void>();

function publish(next: IdentitySession | null): void {
  session = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The signed-in identity, or null. Re-renders on sign-in, refresh and sign-out. */
export function useIdentitySession(): IdentitySession | null {
  return useSyncExternalStore(subscribe, () => session);
}

export function currentSession(): IdentitySession | null {
  return session;
}

type Identity = NonNullable<Awaited<ReturnType<SdkHandle['sdk']['identities']['fetch']>>>;

function keysOf(identity: Identity): KeyInfo[] {
  return identity.publicKeys.map((k) => {
    try {
      return keyInfoFrom(k);
    } finally {
      freeQuietly(k);
    }
  });
}

async function namesOf(handle: SdkHandle, identityId: string): Promise<string[]> {
  try {
    return await handle.sdk.dpns.usernames({ identityId, limit: 5 });
  } catch {
    return [];
  }
}

/** The ids of the identities holding a key with this HASH160. */
async function identitiesByKeyHash(handle: SdkHandle, hash160: string): Promise<string[]> {
  const unique = await handle.sdk.identities.byPublicKeyHash(hash160);
  if (unique) {
    try {
      return [unique.id.toBase58()];
    } finally {
      freeQuietly(unique);
    }
  }
  const shared = await handle.sdk.identities.byNonUniquePublicKeyHash(hash160);
  return shared.map((identity) => {
    try {
      return identity.id.toBase58();
    } finally {
      freeQuietly(identity);
    }
  });
}

/**
 * Sign in with a private key. `chosenId` picks among several identities
 * sharing an ECDSA_HASH160 key (see `choose` in the result).
 */
export async function signIn(
  network: Network,
  wif: string,
  chosenId?: string,
): Promise<SignInResult> {
  const trimmed = wif.trim();
  const keyNetwork = wifNetwork(trimmed);
  if (!keyNetwork) return { ok: false, error: 'That is not a Dash private key in WIF format.' };
  if (keyNetwork !== network) {
    return { ok: false, error: `This is a ${keyNetwork} key, but you are on ${network}. Nothing was loaded.` };
  }
  try {
    const handle = await loadSdk(network);
    const privateKey = handle.mod.PrivateKey.fromWIF(trimmed);
    let hash160: string;
    let publicKeyHex: string;
    try {
      hash160 = privateKey.getPublicKeyHash().toLowerCase();
      const pub = privateKey.getPublicKey();
      try {
        publicKeyHex = bytesToHex(pub.toBytes());
      } finally {
        freeQuietly(pub);
      }
    } finally {
      freeQuietly(privateKey);
    }
    const ids = await identitiesByKeyHash(handle, hash160);
    if (ids.length === 0) {
      return { ok: false, error: `No identity on ${network} holds this key.` };
    }
    const identityId = chosenId && ids.includes(chosenId) ? chosenId : ids.length === 1 ? ids[0] : undefined;
    if (!identityId) return { ok: false, choose: ids };

    const loaded = await readIdentity(handle, identityId);
    if (!loaded) return { ok: false, error: 'The identity could not be read. Try again.' };
    const loginKey = keyMatching(loaded.keys, publicKeyHex, hash160);
    if (!loginKey) return { ok: false, error: 'The identity no longer lists this key.' };
    if (loginKey.disabled) return { ok: false, error: `Key #${loginKey.keyId} of this identity is disabled.` };
    if (isMasterKey(loginKey)) {
      return {
        ok: false,
        error:
          'This is the identity\'s MASTER key. EvoVote does not keep it: sign in with a HIGH or CRITICAL authentication key. The master key is asked for only when a key must be added, and dropped right after.',
      };
    }
    loginWif = trimmed;
    heldKeys.clear();
    publish({ network, identityId, ...loaded, names: await namesOf(handle, identityId), loginKey });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function readIdentity(
  handle: SdkHandle,
  identityId: string,
): Promise<{ balance: bigint; revision: bigint; keys: KeyInfo[] } | undefined> {
  const identity = await handle.sdk.identities.fetch(identityId);
  if (!identity) return undefined;
  try {
    return { balance: identity.balance, revision: identity.revision, keys: keysOf(identity) };
  } finally {
    freeQuietly(identity);
  }
}

/** Re-read the balance and keys (after a write). Throws when the read fails. */
export async function refreshIdentity(): Promise<void> {
  const current = session;
  if (!current) return;
  const handle = await loadSdk(current.network);
  const loaded = await readIdentity(handle, current.identityId);
  if (!loaded) throw new Error('The identity could not be read.');
  if (session?.identityId !== current.identityId) return;
  const loginKey = loaded.keys.find((k) => k.keyId === current.loginKey.keyId) ?? current.loginKey;
  publish({ ...current, ...loaded, loginKey });
}

export function signOut(): void {
  loginWif = null;
  heldKeys.clear();
  publish(null);
}

/** Whether the session can sign document writes on a contract, and if not, why. */
export function documentSigningProblem(s: IdentitySession | null, contractId: string): string | undefined {
  if (!s) return 'Sign in with your identity first.';
  if (!canSignDocumentsFor(s.loginKey, contractId)) {
    return `Key #${s.loginKey.keyId} (${s.loginKey.purpose} · ${s.loginKey.securityLevel}) cannot sign documents here. Sign in with a HIGH or CRITICAL authentication key that is not bound to another contract.`;
  }
  return undefined;
}

type SdkModule = SdkHandle['mod'];
export interface DocumentSigner {
  identityId: string;
  identityKey: InstanceType<SdkModule['IdentityPublicKey']>;
  signer: InstanceType<SdkModule['IdentitySigner']>;
}

/**
 * Run `fn` with the session's signing key for a document write on
 * `contractId`. The key is read from a fresh identity fetch and checked
 * against the held private key; every wasm object is freed afterwards.
 */
export async function withDocumentSigner<T>(
  handle: SdkHandle,
  contractId: string,
  fn: (s: DocumentSigner) => Promise<T>,
): Promise<T> {
  const s = session;
  const problem = documentSigningProblem(s, contractId);
  if (problem || !s || !loginWif) throw new Error(problem ?? 'Sign in with your identity first.');
  const identity = await handle.sdk.identities.fetch(s.identityId);
  if (!identity) throw new Error('The identity could not be read.');
  const owned: unknown[] = [identity];
  try {
    const identityKey = identity.getPublicKeyById(s.loginKey.keyId);
    if (!identityKey) throw new Error(`The identity no longer has key #${s.loginKey.keyId}.`);
    owned.push(identityKey);
    const privateKey = handle.mod.PrivateKey.fromWIF(loginWif);
    owned.push(privateKey);
    if (identityKey.getPublicKeyHash().toLowerCase() !== privateKey.getPublicKeyHash().toLowerCase()) {
      throw new Error('The held key does not match the identity key any more. Sign in again.');
    }
    const signer = new handle.mod.IdentitySigner();
    owned.push(signer);
    signer.addKey(privateKey);
    return await fn({ identityId: s.identityId, identityKey, signer });
  } finally {
    owned.forEach(freeQuietly);
  }
}

/** Hold an extra private key (hex) for this session, e.g. a charter decryption key. */
export function holdPrivateKey(hash160: string, privateKeyHex: string): void {
  heldKeys.set(hash160.toLowerCase(), privateKeyHex.toLowerCase());
  // Views that show which keys are loaded re-render.
  if (session) publish({ ...session });
}

/** The held private key (hex) for an identity key, if any. */
export function heldPrivateKeyFor(key: KeyInfo): string | undefined {
  return heldKeys.get(key.hash160);
}

/** Test hook: reset module state. */
export function resetSessionForTests(next: { session: IdentitySession | null; wif?: string } = { session: null }): void {
  loginWif = next.wif ?? null;
  heldKeys.clear();
  publish(next.session);
}
