import { useSyncExternalStore } from 'react';
import { boundsMatch, type AppConnectHealth, type RenewSoonReason } from '../appconnect/health';
import { toAppConnectIdentityKey, type WasmIdentityKeyLike } from '../appconnect/keyMapping';
import {
  selectSigningKey,
  type AppConnectGrant,
  type AppConnectSessionKey,
  type SigningRequest,
} from '../appconnect/protocol';
import { walletSessions } from '../appconnect/runtime';
import type { WalletSessions } from '../appconnect/sessions';
import { documentSigningRequest, explainNoCoveringKey, rawSessionKey } from '../appconnect/signingPlan';
import { CHARTERS_CONTRACT_ID } from '../charters/documents';
import { discussionContractId } from '../discussion/config';
import { bytesToHex } from '../model/bytes';
import { loadSdk, type SdkHandle } from '../sdk/connection';
import { errorCode, errorMessage } from '../sdk/errors';
import { freeQuietly } from '../sdk/free';
import type { Network } from '../sdk/network';
import { wifNetwork } from '../voting/keys';
import { canSignDocumentsFor, keyInfoFrom, keyInfosOf, keyMatching, signInKeyRefusal, type KeyInfo } from './keys';
import { existingBoundKey, type BoundKeySpec } from './update';

/**
 * The identity session (`#/me`). Two ways in:
 *
 * - **Dash Wallet** (App Connect, `via: 'wallet'`): the wallet adds a HIGH
 *   key bound to the discussion contract, with a 0.1 DASH allowance and an
 *   expiry, and hands its private half to this browser, where it is kept
 *   wrapped in IndexedDB (src/appconnect). It survives reloads; signing out
 *   forgets it here, and the key stays on the identity until it is revoked
 *   in Dash Wallet. It signs comments only: the wallet refuses keys for the
 *   moderation charters system contract.
 * - **A private key** (`via: 'key'`): a pasted HIGH or CRITICAL
 *   authentication key, found by its public-key hash, kept in this module's
 *   memory only and gone on reload. A MASTER key is refused: it is asked for
 *   just in time by the one write that needs it (adding a charter key) and
 *   dropped right after.
 *
 * While signed in with the wallet, a pasted key can be added for one step
 * (`addStepKey`): charter writes need it.
 *
 * Callers: `useIdentitySession()` for the view, `documentSigningProblem()` to
 * say before a paid step why it cannot be signed, `withDocumentSigner()` to
 * sign a document write, `refreshIdentity()` after a write.
 */
export type SignedInVia = 'wallet' | 'key';

/** The public side of the wallet's key ring (no private keys). */
export interface WalletView {
  keys: AppConnectSessionKey[];
  health: AppConnectHealth;
  renewSoon: RenewSoonReason | null;
}

export interface IdentitySession {
  network: Network;
  identityId: string;
  /** DPNS names (best effort; empty when none or unreadable). */
  names: string[];
  /** Credits (1 DASH = 1e11). */
  balance: bigint;
  revision: bigint;
  keys: KeyInfo[];
  /** How the user signed in. */
  via: SignedInVia;
  /** The pasted key: the sign-in key (`via: 'key'`), or a key added for a step while signed in with the wallet. */
  pastedKey?: KeyInfo;
  /** The wallet's key ring, when signed in with Dash Wallet. */
  wallet?: WalletView;
}

/** The document write being signed: the contract, and the document type (bound keys sign only theirs). */
export interface DocumentTarget {
  contractId: string;
  documentType: string;
}

/**
 * Why a write cannot be signed:
 * - `renew`: the wallet's key would cover it but has expired or spent its allowance;
 * - `needs-key`: no key held covers it (a charter write while signed in with the wallet);
 * - `signed-out`: nobody is signed in.
 */
export type SigningProblemReason = 'renew' | 'needs-key' | 'signed-out';

export interface SigningProblem {
  reason: SigningProblemReason;
  message: string;
}

export class SigningUnavailableError extends Error {
  constructor(
    readonly reason: SigningProblemReason,
    message: string,
  ) {
    super(message);
    this.name = 'SigningUnavailableError';
  }
}

export const SIGNED_OUT_MESSAGE = 'Sign in first.';
export const SIGNED_OUT_ELSEWHERE_MESSAGE =
  "You were signed out here: another EvoVote tab signed out or signed in as someone else, or this browser's saved sign-in was cleared. Sign in again.";
export const RENEWED_ELSEWHERE_MESSAGE = 'Your Dash Wallet sign-in was renewed in another tab. Try again.';
export const RENEW_MESSAGE =
  'Your Dash Wallet sign-in for EvoVote has expired or used up its allowance. Sign in with Dash Wallet again to renew it.';
export const WALLET_CHARTERS_MESSAGE =
  "Dash Wallet can't sign moderation-charter documents yet. Add a HIGH authentication key for this step.";
const WALLET_OTHER_MESSAGE = "Dash Wallet's key for EvoVote can't sign this. Add a HIGH authentication key for this step.";

/**
 * What a sign-out leaves to say on `#/me`: signed out here, the wallet
 * revoked the key, signed out in another tab (the stored keys were gone), or
 * signed out but this browser could not delete the stored keys.
 */
export type SignOutNotice = 'wallet-signed-out' | 'wallet-revoked' | 'wallet-signed-out-elsewhere' | 'wallet-forget-failed' | null;

type SignInResult =
  | { ok: true }
  | { ok: false; error: string }
  /** The key hash is shared by several identities: pick one and sign in again. */
  | { ok: false; choose: string[] };

let session: IdentitySession | null = null;
/** The pasted key's WIF (see `pastedKey`). */
let pastedWif: string | null = null;
/** Extra private keys (hex) held for this session, by HASH160 of their public key. */
const heldKeys = new Map<string, string>();
/** True while a stored wallet sign-in is being restored on page load. */
let restoring = false;
let signOutNotice: SignOutNotice = null;
/** The wallet sign-in whose stored keys a sign-out could not delete, for "Try again". */
let unforgotten: { network: Network; identityId: string } | null = null;
const listeners = new Set<() => void>();

/** Drop every private key this module holds (the wallet's ring is not here). */
function dropHeldKeys(notice: SignOutNotice): void {
  pastedWif = null;
  heldKeys.clear();
  signOutNotice = notice;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(next: IdentitySession | null): void {
  session = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The signed-in identity, or null. Re-renders on sign-in, refresh and sign-out. */
export function useIdentitySession(): IdentitySession | null {
  return useSyncExternalStore(subscribe, () => session, () => session);
}

/** True while a wallet sign-in from an earlier visit is being restored. */
export function useSessionRestoring(): boolean {
  return useSyncExternalStore(subscribe, () => restoring, () => restoring);
}

export function getSignOutNotice(): SignOutNotice {
  return signOutNotice;
}

/** What the last sign-out should explain (wallet keys stay on the identity). */
export function useSignOutNotice(): SignOutNotice {
  return useSyncExternalStore(subscribe, () => signOutNotice, () => signOutNotice);
}

export function dismissSignOutNotice(): void {
  signOutNotice = null;
  notify();
}

/** The contracts EvoVote writes documents to on `network`. */
function writableContracts(network: Network): string[] {
  const discussion = discussionContractId(network);
  return discussion ? [CHARTERS_CONTRACT_ID, discussion] : [CHARTERS_CONTRACT_ID];
}

function contractName(network: Network): (id: string) => string {
  return (id) =>
    id === CHARTERS_CONTRACT_ID
      ? 'the moderation charters contract'
      : id === discussionContractId(network)
        ? "EvoVote's discussion contract"
        : `contract ${id.slice(0, 6)}…`;
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

async function readIdentity(
  handle: SdkHandle,
  identityId: string,
): Promise<{ balance: bigint; revision: bigint; keys: KeyInfo[] } | undefined> {
  const identity = await handle.sdk.identities.fetch(identityId);
  if (!identity) return undefined;
  try {
    return { balance: identity.balance, revision: identity.revision, keys: keyInfosOf(identity) };
  } finally {
    freeQuietly(identity);
  }
}

/** A pasted WIF's public key (hex) and HASH160, or an error for the user. */
function readPastedKey(
  handle: SdkHandle,
  network: Network,
  wif: string,
): { ok: true; publicKeyHex: string; hash160: string } | { ok: false; error: string } {
  const keyNetwork = wifNetwork(wif);
  if (!keyNetwork) return { ok: false, error: 'That is not a Dash private key in WIF format.' };
  if (keyNetwork !== network) {
    return { ok: false, error: `This is a ${keyNetwork} key, but you are on ${network}. Nothing was loaded.` };
  }
  const privateKey = handle.mod.PrivateKey.fromWIF(wif);
  try {
    const hash160 = privateKey.getPublicKeyHash().toLowerCase();
    const pub = privateKey.getPublicKey();
    try {
      return { ok: true, hash160, publicKeyHex: bytesToHex(pub.toBytes()) };
    } finally {
      freeQuietly(pub);
    }
  } finally {
    freeQuietly(privateKey);
  }
}

/**
 * Sign in with a private key. `chosenId` picks among several identities
 * sharing an ECDSA_HASH160 key (see `choose` in the result).
 */
export async function signIn(network: Network, wif: string, chosenId?: string): Promise<SignInResult> {
  const trimmed = wif.trim();
  try {
    const handle = await loadSdk(network);
    const pasted = readPastedKey(handle, network, trimmed);
    if (!pasted.ok) return pasted;
    const ids = await identitiesByKeyHash(handle, pasted.hash160);
    if (ids.length === 0) {
      return { ok: false, error: `No identity on ${network} holds this key.` };
    }
    let identityId = ids.length === 1 ? ids[0] : undefined;
    if (chosenId && ids.includes(chosenId)) identityId = chosenId;
    if (!identityId) return { ok: false, choose: ids };

    const loaded = await readIdentity(handle, identityId);
    if (!loaded) return { ok: false, error: 'The identity could not be read. Try again.' };
    const key = keyMatching(loaded.keys, pasted.publicKeyHex, pasted.hash160);
    if (!key) return { ok: false, error: 'The identity no longer lists this key.' };
    const refusal = signInKeyRefusal(key, loaded.keys, writableContracts(network), contractName(network));
    if (refusal) return { ok: false, error: refusal };
    // A wallet ring from an earlier visit is replaced by this sign-in.
    const ring = walletSessions(network);
    const stored = ring?.current();
    if (stored) await ring?.logout(stored.identityId);
    // An earlier sign-out left wallet keys stored: delete them, or the next load restores that sign-in.
    if (unforgotten?.network === network && ring && (await ring.logout(unforgotten.identityId))) unforgotten = null;
    dropHeldKeys(null);
    pastedWif = trimmed;
    publish({ network, identityId, ...loaded, names: await namesOf(handle, identityId), via: 'key', pastedKey: key });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * While signed in with Dash Wallet: load a pasted HIGH or CRITICAL key of
 * the same identity for steps the wallet's key cannot sign (charter writes).
 * Memory only, like a key sign-in; the wallet sign-in stays.
 */
export async function addStepKey(wif: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = session;
  if (!current) return { ok: false, error: 'Sign in first.' };
  const trimmed = wif.trim();
  try {
    const handle = await loadSdk(current.network);
    const pasted = readPastedKey(handle, current.network, trimmed);
    if (!pasted.ok) return pasted;
    const loaded = await readIdentity(handle, current.identityId);
    if (!loaded) return { ok: false, error: 'The identity could not be read. Try again.' };
    const key = keyMatching(loaded.keys, pasted.publicKeyHex, pasted.hash160);
    if (!key) return { ok: false, error: `This key is not one of ${current.names[0] ?? 'this identity'}'s keys.` };
    // The wallet's key already signs comments: a step key is for charter writes.
    const refusal = signInKeyRefusal(key, loaded.keys, [CHARTERS_CONTRACT_ID], contractName(current.network));
    if (refusal) return { ok: false, error: refusal };
    if (session?.identityId !== current.identityId) return { ok: false, error: 'You signed out meanwhile.' };
    pastedWif = trimmed;
    publish({ ...session, ...loaded, pastedKey: key });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Drop a key added for a step (wallet sign-ins only; a key sign-in signs out instead). */
export function forgetStepKey(): void {
  if (!session || session.via !== 'wallet') return;
  pastedWif = null;
  const { pastedKey: _dropped, ...rest } = session;
  publish(rest);
}

function walletView(ring: WalletSessions, identityId: string): WalletView | undefined {
  const active = ring.current(identityId);
  if (!active) return undefined;
  const status = ring.getStatus();
  return {
    keys: active.authKeys,
    health: status.health ?? 'ok',
    renewSoon: status.renewSoon,
  };
}

/** Keeps the session's wallet view in step with the ring (budget re-reads, renewals, revokes). */
const watchedRings = new WeakSet<WalletSessions>();
function watchRing(ring: WalletSessions): void {
  if (watchedRings.has(ring)) return;
  watchedRings.add(ring);
  ring.onSignedOut((identityId, reason) => {
    if (session?.identityId !== identityId || session.via !== 'wallet') return;
    dropHeldKeys(reason === 'missing' ? 'wallet-signed-out-elsewhere' : 'wallet-revoked');
    publish(null);
  });
  ring.subscribe(() => {
    const current = session;
    if (!current || current.via !== 'wallet') return;
    const view = walletView(ring, current.identityId);
    if (view) publish({ ...current, wallet: view });
  });
}

async function publishWalletSession(network: Network, ring: WalletSessions, identityId: string): Promise<void> {
  const handle = await loadSdk(network);
  const loaded = await readIdentity(handle, identityId);
  if (!loaded) throw new Error('The identity could not be read.');
  const names = await namesOf(handle, identityId);
  const wallet = walletView(ring, identityId);
  if (!wallet) throw new Error('Signed out while the wallet was connecting.');
  // A renewal keeps the keys loaded for this identity (a step key, a charter decryption key).
  const same = session?.identityId === identityId ? session : null;
  if (!same) dropHeldKeys(null);
  signOutNotice = null;
  const pastedKey = same?.pastedKey ? loaded.keys.find((k) => k.keyId === same.pastedKey?.keyId) : undefined;
  publish({ network, identityId, ...loaded, names, via: 'wallet', wallet, ...(pastedKey ? { pastedKey } : {}) });
}

/** Read the identity, retrying a lagging or failed read a few times. */
async function publishWithRetries(network: Network, ring: WalletSessions, identityId: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await publishWalletSession(network, ring, identityId);
      return;
    } catch (e) {
      if (attempt >= 2 || !ring.current(identityId)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/**
 * The wallet's keys are stored and active, but the identity could not be
 * read yet: try again without asking the wallet for a new (paid) grant.
 */
export async function resumeWalletSession(network: Network): Promise<boolean> {
  const ring = walletSessions(network);
  const active = ring?.current();
  if (!ring || !active) return false;
  await publishWalletSession(network, ring, active.identityId);
  return true;
}

/**
 * Sign in with a grant the user confirmed ("Continue as …"): store the
 * wallet's keys and read the identity. The grant's private keys are wiped.
 */
export async function signInWithWallet(network: Network, grant: AppConnectGrant): Promise<void> {
  const ring = walletSessions(network);
  if (!ring) {
    for (const granted of [...grant.authKeys, ...grant.encryptionKeys]) granted.privateKey.fill(0);
    throw new Error('Wallet sign-in is not set up on this site.');
  }
  watchRing(ring);
  // A new sign-in supersedes an earlier sign-out's failed delete ("Try again" must not sign it out).
  unforgotten = null;
  const adopted = await ring.adopt(grant);
  // A failed read leaves the keys stored and active: `resumeWalletSession` (or a reload) finishes it.
  await publishWithRetries(network, ring, adopted.identityId);
}

/**
 * Page load: restore this network's wallet sign-in, if one is stored, without
 * asking again (each wallet sign-in is a paid identity update). A failed
 * identity read leaves the ring stored for the next load.
 */
export async function restoreWalletSession(network: Network): Promise<void> {
  const ring = walletSessions(network);
  if (!ring || session) return;
  watchRing(ring);
  restoring = true;
  notify();
  try {
    const restored = await ring.restore();
    // `session` may have changed while restoring: a key sign-in that finished first replaces the stored wallet sign-in.
    const now = session as IdentitySession | null;
    if (restored && now?.via === 'key') await ring.logout(restored.identityId);
    else if (restored && !now) {
      await publishWithRetries(network, ring, restored.identityId);
      // Show the allowance as it is now, and catch a revoke since the last visit.
      void ring.refresh();
    }
  } catch (e) {
    console.warn('Wallet sign-in: could not restore the session', e);
  } finally {
    restoring = false;
    notify();
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
  const pastedKey = session.pastedKey
    ? (loaded.keys.find((k) => k.keyId === session?.pastedKey?.keyId) ?? session.pastedKey)
    : undefined;
  publish({ ...session, ...loaded, ...(pastedKey ? { pastedKey } : {}) });
}

/**
 * Sign out. A wallet sign-in forgets this browser's keys (the key stays on
 * the identity until it is revoked in Dash Wallet) but keeps the connection
 * id, so the next wallet sign-in replaces that key instead of adding another.
 */
export async function signOut(): Promise<void> {
  const current = session;
  dropHeldKeys(current?.via === 'wallet' ? 'wallet-signed-out' : null);
  publish(null);
  if (current?.via === 'wallet') await forgetWallet({ network: current.network, identityId: current.identityId });
}

/** Delete a signed-out wallet sign-in's stored keys; on failure, say so (a reload could restore them). */
async function forgetWallet(target: { network: Network; identityId: string }): Promise<void> {
  const ring = walletSessions(target.network);
  const forgotten = ring ? await ring.logout(target.identityId) : true;
  unforgotten = forgotten ? null : target;
  // A sign-in that finished meanwhile has its own (no) notice.
  if (session) return;
  signOutNotice = forgotten ? 'wallet-signed-out' : 'wallet-forget-failed';
  notify();
}

/** "Try again" on a sign-out whose stored keys could not be deleted. */
export async function retryForgetWallet(): Promise<void> {
  const target = unforgotten;
  if (!target) return;
  // Signed in again since: that sign-in owns the stored ring now.
  if (session || walletSessions(target.network)?.current(target.identityId)) {
    unforgotten = null;
    return;
  }
  await forgetWallet(target);
}

type Resolution =
  | { kind: 'wallet'; key: AppConnectSessionKey; request: SigningRequest }
  | { kind: 'pasted'; key: KeyInfo }
  | { kind: 'problem'; problem: SigningProblem };

/**
 * Which key signs a write of `target`: the wallet's (the narrowest live key
 * covering it), else the pasted key, else why not. Pure.
 */
export function resolveSigning(
  s: IdentitySession | null,
  target: DocumentTarget,
  walletKeys: AppConnectSessionKey[] | undefined,
  now: number,
): Resolution {
  if (!s) return { kind: 'problem', problem: { reason: 'signed-out', message: SIGNED_OUT_MESSAGE } };
  const request = documentSigningRequest(target.contractId, target.documentType);
  let renew = false;
  if (walletKeys) {
    const ctx = { now, groups: [] };
    const selection = selectSigningKey(walletKeys, request, ctx);
    if (selection.ok) return { kind: 'wallet', key: selection.key, request };
    renew = explainNoCoveringKey(walletKeys, request, ctx) === 'renew';
  }
  if (s.pastedKey && canSignDocumentsFor(s.pastedKey, target.contractId, target.documentType)) {
    return { kind: 'pasted', key: s.pastedKey };
  }
  if (renew) return { kind: 'problem', problem: { reason: 'renew', message: RENEW_MESSAGE } };
  if (s.via === 'wallet') {
    return {
      kind: 'problem',
      problem: {
        reason: 'needs-key',
        message: target.contractId === CHARTERS_CONTRACT_ID ? WALLET_CHARTERS_MESSAGE : WALLET_OTHER_MESSAGE,
      },
    };
  }
  const k = s.pastedKey;
  return {
    kind: 'problem',
    problem: {
      reason: 'needs-key',
      message: k
        ? `Key #${k.keyId} (${k.purpose} · ${k.securityLevel}${k.bounds ? ', bound to another contract or document type' : ''}) cannot sign this. Sign in with a HIGH or CRITICAL authentication key that is not bound elsewhere.`
        : 'Sign in with a HIGH or CRITICAL authentication key.',
    },
  };
}

/** Whether the session can sign a document write of `target`, and if not, why. */
export function documentSigningProblem(s: IdentitySession | null, target: DocumentTarget): SigningProblem | undefined {
  const resolution = resolveSigning(s, target, s?.wallet?.keys, Date.now());
  return resolution.kind === 'problem' ? resolution.problem : undefined;
}

type SdkModule = SdkHandle['mod'];
export interface DocumentSigner {
  identityId: string;
  identityKey: InstanceType<SdkModule['IdentityPublicKey']>;
  signer: InstanceType<SdkModule['IdentitySigner']>;
}

/** A `WriteOutcome`'s refusal code, when `value` is one. */
function refusalCode(value: unknown): number | undefined | null {
  if (!value || typeof value !== 'object' || !('status' in value)) return null;
  const outcome = value as { status: unknown; error?: { code?: number } };
  if (outcome.status === 'refused') return outcome.error?.code;
  return outcome.status === 'confirmed' || outcome.status === 'pending' ? null : undefined;
}

/**
 * Run `fn` with the signing key for a document write of `target`: the
 * wallet's key when it covers the write, else the pasted key. The key is read
 * from a fresh identity fetch and checked against the held private key; every
 * wasm object is freed afterwards. Throws `SigningUnavailableError` when no
 * key can sign.
 */
export async function withDocumentSigner<T>(
  handle: SdkHandle,
  target: DocumentTarget,
  fn: (s: DocumentSigner) => Promise<T>,
): Promise<T> {
  const s = session;
  if (!s) throw new SigningUnavailableError('signed-out', SIGNED_OUT_MESSAGE);
  const ring = s.via === 'wallet' ? walletSessions(s.network) : null;
  const active = ring?.current(s.identityId) ?? null;
  const resolution = resolveSigning(s, target, active?.authKeys, Date.now());
  if (resolution.kind === 'problem') throw new SigningUnavailableError(resolution.problem.reason, resolution.problem.message);
  const identity = await handle.sdk.identities.fetch(s.identityId);
  if (!identity) throw new Error('The identity could not be read.');
  const owned: unknown[] = [identity];
  try {
    const keyId = resolution.key.keyId;
    const identityKey = identity.getPublicKeyById(keyId);
    owned.push(identityKey);
    const wallet = resolution.kind === 'wallet' && ring && active ? { ring, active, key: resolution.key } : null;
    if (!identityKey) {
      if (wallet) await wallet.ring.refresh();
      throw new SigningUnavailableError(wallet ? 'signed-out' : 'needs-key', `The identity no longer has key #${keyId}. Sign in again.`);
    }
    let privateKey: ReturnType<SdkModule['PrivateKey']['fromWIF']>;
    if (wallet) {
      // The key as it is now: the wallet may have revoked or replaced it since.
      const chain = toAppConnectIdentityKey(identityKey as unknown as WasmIdentityKeyLike);
      if (!chain || chain.disabledAt !== undefined || !boundsMatch(chain.bounds, wallet.key.bounds)) {
        await wallet.ring.refresh();
        if (!wallet.ring.current(s.identityId)) {
          throw new SigningUnavailableError('signed-out', "Dash Wallet revoked this browser's key. Sign in again.");
        }
        throw new SigningUnavailableError('renew', RENEW_MESSAGE);
      }
      // Signed out (here or in another tab) during the reads above: sign nothing.
      if (session?.identityId !== s.identityId || !wallet.ring.current(s.identityId)) {
        throw new SigningUnavailableError('signed-out', SIGNED_OUT_MESSAGE);
      }
      const bytes = await wallet.ring.privateKey(wallet.active, wallet.key.keyRef);
      if (!bytes) {
        await wallet.ring.signOutRevoked(wallet.active, 'missing');
        // Another tab renewed this sign-in: the ring switched to the newer grant, so a retry signs.
        if (wallet.ring.current(s.identityId)) throw new Error(RENEWED_ELSEWHERE_MESSAGE);
        throw new SigningUnavailableError('signed-out', SIGNED_OUT_ELSEWHERE_MESSAGE);
      }
      try {
        privateKey = handle.mod.PrivateKey.fromBytes(bytes, s.network);
      } finally {
        bytes.fill(0);
      }
    } else {
      // The key as it is now, not as it was when it was pasted (it may have been disabled since).
      if (!canSignDocumentsFor(keyInfoFrom(identityKey), target.contractId, target.documentType)) {
        throw new SigningUnavailableError('needs-key', `Key #${keyId} can no longer sign this. Load another key.`);
      }
      await assertPastedKeyCovers(handle, s.identityId, identityKey as unknown as WasmIdentityKeyLike, target);
      if (!pastedWif) throw new SigningUnavailableError('needs-key', 'Load your key again.');
      privateKey = handle.mod.PrivateKey.fromWIF(pastedWif);
    }
    owned.push(privateKey);
    if (identityKey.getPublicKeyHash().toLowerCase() !== privateKey.getPublicKeyHash().toLowerCase()) {
      if (wallet) await wallet.ring.signOutRevoked(wallet.active);
      throw new SigningUnavailableError('signed-out', 'The held key does not match the identity key any more. Sign in again.');
    }
    const signer = new handle.mod.IdentitySigner();
    owned.push(signer);
    signer.addKey(privateKey);
    const signing = { identityId: s.identityId, identityKey, signer };
    if (!wallet) return await fn(signing);
    let result: T;
    try {
      result = await fn(signing);
    } catch (e) {
      await wallet.ring.handleWriteFailure(s.identityId, errorCode(e));
      throw e;
    }
    // A refusal with a key-ring code (allowance spent, key revoked) updates the ring.
    const code = refusalCode(result);
    if (code === null) wallet.ring.noteWriteLanded(s.identityId);
    else if (code !== undefined) await wallet.ring.handleWriteFailure(s.identityId, code);
    return result;
  } finally {
    owned.forEach(freeQuietly);
  }
}

/**
 * A pasted key that is bound or limited gets the wallet keys' check before
 * signing: it must cover the write and have time and allowance left.
 */
async function assertPastedKeyCovers(
  handle: SdkHandle,
  identityId: string,
  identityKey: WasmIdentityKeyLike,
  target: DocumentTarget,
): Promise<void> {
  const limited = Boolean(identityKey.contractBounds) || identityKey.totalBudget != null || identityKey.expiresAt != null;
  if (!limited) return;
  const mapped = toAppConnectIdentityKey(identityKey);
  if (!mapped) throw new SigningUnavailableError('needs-key', 'Your key could not be read. Load it again.');
  let remaining: bigint | undefined;
  if (mapped.totalBudget !== undefined) {
    remaining = (await handle.sdk.identities.keysRemainingBudgets(identityId, [mapped.id])).get(mapped.id) ?? undefined;
  }
  const ringKey = rawSessionKey(mapped, remaining);
  if (!ringKey) return;
  const request = documentSigningRequest(target.contractId, target.documentType);
  if (!selectSigningKey([ringKey], request, { now: Date.now(), groups: [] }).ok) {
    throw new SigningUnavailableError('needs-key', `Key #${mapped.id} has expired or used up its allowance. Load another key.`);
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

/** The held private key (hex) of the identity's key bound per `spec`, if that key is on chain and loaded. */
export function heldBoundKeyHex(session: IdentitySession, spec: BoundKeySpec): string | undefined {
  const key = existingBoundKey(session.keys, spec);
  return key ? heldPrivateKeyFor(key) : undefined;
}
