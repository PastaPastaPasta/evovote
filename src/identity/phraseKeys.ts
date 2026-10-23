import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '../model/bytes';
import { shortId } from '../model/text';
import type { SdkHandle } from '../sdk/connection';
import { freeQuietly } from '../sdk/free';
import type { Network } from '../sdk/network';
import {
  dip13Wallet,
  identityAuthKeyPath,
  IDENTITY_GAP_LIMIT,
  InvalidPhraseError,
  MASTER_KEY_INDEX,
  normalizeRecoveryPhrase,
  type Dip13Wallet,
} from './dip13';
import { isDocumentSigningKey, isMasterKey, keyInfosOf, keyMatching, type KeyInfo } from './keys';

/**
 * A recovery phrase in place of a pasted key, for the steps Dash Wallet
 * cannot sign yet (charter writes, and the MASTER-signed update that adds a
 * charter key): find which of the signed-in identity's keys the phrase
 * derives, the way Dash Wallet derives them (dip13.ts), and hand back that
 * one key as a WIF. The caller then runs it through the same checks as a
 * pasted WIF.
 *
 * The phrase is read here only: never stored, logged or sent. Derived key
 * bytes are zeroed once their WIF is taken; the phrase string cannot be
 * zeroed, so nothing keeps a reference to it after the call.
 *
 * Adapted from Yappr's lib/auth/critical-key-input.ts and
 * lib/auth/recovery-phrase.ts (https://github.com/PastaPastaPasta/yappr, MIT).
 */

/** Which key the phrase should unlock. */
export type PhraseKeyWant =
  /** An enabled, unbound HIGH or CRITICAL authentication key: signs charter documents (HIGH preferred). */
  | 'document-signing'
  /** The enabled MASTER authentication key: signs the identity update that adds a charter key. */
  | 'master';

/** Identity indexes scanned at most, whatever the gap limit allows (a phrase with many identities stays bounded). */
export const MAX_IDENTITY_INDEXES = 20;

export const INVALID_PHRASE = "That recovery phrase isn't valid. Check each word and try again.";
export const NOT_A_PHRASE = 'A recovery phrase has 12 to 24 words.';

/** Twelve words or more reads as a recovery phrase. */
export function looksLikeRecoveryPhrase(input: string): boolean {
  return normalizeRecoveryPhrase(input).split(' ').length >= 12;
}

const LEVEL_ORDER: Record<string, number> = { HIGH: 0, CRITICAL: 1, MASTER: 2 };
/** Key types a derived secp256k1 key can be: by public key, or by its hash. */
const DERIVABLE_TYPES = new Set(['ECDSA_SECP256K1', 'ECDSA_HASH160']);

/**
 * The identity's keys the phrase may stand in for, most preferred first: for
 * document signing, enabled unbound HIGH then CRITICAL authentication keys
 * (the least powerful key that signs); for `master`, the MASTER key. Pure.
 */
export function phraseCandidates(keys: readonly KeyInfo[], want: PhraseKeyWant): KeyInfo[] {
  const fits = want === 'master' ? isMasterKey : (k: KeyInfo) => isDocumentSigningKey(k) && !k.bounds;
  return keys
    .filter((k) => fits(k) && DERIVABLE_TYPES.has(k.keyType) && k.keyId >= 0 && k.keyId < 0x80000000)
    .sort((a, b) => (LEVEL_ORDER[a.securityLevel] ?? 9) - (LEVEL_ORDER[b.securityLevel] ?? 9) || a.keyId - b.keyId);
}

function hash160Hex(publicKey: Uint8Array): string {
  return bytesToHex(ripemd160(sha256(publicKey)));
}

export type PhraseKeyFound = { ok: true; key: KeyInfo; privateKey: Uint8Array } | { ok: false; error: string };

/** What to say when the phrase holds none of the wanted keys. */
function missingKeyText(want: PhraseKeyWant, who: string): string {
  return want === 'master'
    ? `This recovery phrase doesn't hold ${who}'s master key. Paste the master key instead.`
    : `This recovery phrase doesn't hold a HIGH or CRITICAL key of ${who} that can sign this. Paste the key instead.`;
}

/**
 * Find which of `keys` (the signed-in identity's, read fresh) `wallet`
 * derives. Identity indexes are walked as a wallet discovers them: at each,
 * the candidates are checked locally first; when none matches, the index's
 * MASTER key is looked up on chain (`identityByMasterHash`), and the scan
 * stops after IDENTITY_GAP_LIMIT unused indexes in a row (or
 * MAX_IDENTITY_INDEXES in all). A phrase whose identities are all someone
 * else's is refused as such. A failed lookup throws: an unanswered read is
 * never "not this phrase". Every derived key but the one returned is zeroed;
 * the caller zeroes that one.
 */
export async function findPhraseKey(args: {
  wallet: Dip13Wallet;
  network: Network;
  identityId: string;
  /** "alice.dash", or the short id: who the refusals name. */
  who: string;
  keys: readonly KeyInfo[];
  want: PhraseKeyWant;
  identityByMasterHash: (hash160Hex: string) => Promise<string | undefined>;
}): Promise<PhraseKeyFound> {
  const { wallet, network, identityId, who, want } = args;
  const candidates = phraseCandidates(args.keys, want);
  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        want === 'master'
          ? `${who} has no enabled master key a recovery phrase can unlock.`
          : `${who} has no HIGH or CRITICAL authentication key a recovery phrase can unlock for this step.`,
    };
  }
  let othersFound = false;
  for (let identityIndex = 0, misses = 0; misses < IDENTITY_GAP_LIMIT && identityIndex < MAX_IDENTITY_INDEXES; identityIndex++) {
    /** Key index 0's public key, when a candidate already derived it (it is also what the lookup needs). */
    let masterPublicKey: Uint8Array | undefined;
    for (const candidate of candidates) {
      const derived = wallet.derive(identityAuthKeyPath(network, identityIndex, candidate.keyId));
      if (keyMatching([candidate], bytesToHex(derived.publicKey), hash160Hex(derived.publicKey))) {
        return { ok: true, key: candidate, privateKey: derived.privateKey };
      }
      derived.privateKey.fill(0);
      if (candidate.keyId === MASTER_KEY_INDEX) masterPublicKey = derived.publicKey;
    }
    if (!masterPublicKey) {
      const master = wallet.derive(identityAuthKeyPath(network, identityIndex, MASTER_KEY_INDEX));
      master.privateKey.fill(0);
      masterPublicKey = master.publicKey;
    }
    const owner = await args.identityByMasterHash(hash160Hex(masterPublicKey));
    // The phrase is this identity's, but holds none of the keys wanted (say, they were added by another wallet).
    if (owner === identityId) return { ok: false, error: missingKeyText(want, who) };
    if (owner) {
      othersFound = true;
      misses = 0;
    } else {
      misses++;
    }
  }
  if (othersFound) {
    return {
      ok: false,
      error: `This recovery phrase belongs to a different identity, not ${who}. Nothing was loaded. Sign in with that identity, or enter ${who}'s phrase.`,
    };
  }
  return { ok: false, error: `No identity on ${network} was created from this recovery phrase. Check it, or paste the key instead.` };
}

/** The identity holding a unique key with this HASH160, if any. */
async function identityByKeyHash(handle: SdkHandle, hash160: string): Promise<string | undefined> {
  const found = await handle.sdk.identities.byPublicKeyHash(hash160);
  if (!found) return undefined;
  try {
    return found.id.toBase58();
  } finally {
    freeQuietly(found);
  }
}

/**
 * The private key (WIF) `phrase` derives for `identityId`'s wanted key, with
 * that key as the chain shows it now. Reads the identity fresh, so a key
 * disabled moments ago is never picked. The WIF is still to be checked by
 * the caller as if it had been pasted.
 */
export async function keyFromPhrase(
  handle: SdkHandle,
  args: { identityId: string; who?: string; phrase: string; want: PhraseKeyWant },
): Promise<{ ok: true; wif: string; key: KeyInfo } | { ok: false; error: string }> {
  if (!looksLikeRecoveryPhrase(args.phrase)) return { ok: false, error: NOT_A_PHRASE };
  let wallet: Dip13Wallet;
  try {
    wallet = dip13Wallet(handle.mod.WasmSdk, args.phrase, handle.network);
  } catch (e) {
    if (e instanceof InvalidPhraseError) return { ok: false, error: INVALID_PHRASE };
    throw e;
  }
  const identity = await handle.sdk.identities.fetch(args.identityId);
  if (!identity) return { ok: false, error: 'The identity could not be read. Try again.' };
  let keys: KeyInfo[];
  try {
    keys = keyInfosOf(identity);
  } finally {
    freeQuietly(identity);
  }
  const found = await findPhraseKey({
    wallet,
    network: handle.network,
    identityId: args.identityId,
    who: args.who ?? shortId(args.identityId),
    keys,
    want: args.want,
    identityByMasterHash: (hash) => identityByKeyHash(handle, hash),
  });
  if (!found.ok) return found;
  try {
    const privateKey = handle.mod.PrivateKey.fromBytes(found.privateKey, handle.network);
    try {
      return { ok: true, wif: privateKey.toWIF(), key: found.key };
    } finally {
      freeQuietly(privateKey);
    }
  } finally {
    found.privateKey.fill(0);
  }
}

/** The plain warning shown next to every recovery-phrase field. */
export function recoveryPhraseWarning(network: Network): string {
  return network === 'testnet'
    ? 'Your recovery phrase controls your whole wallet. Only enter it on testnet sites you trust.'
    : 'Your recovery phrase controls your whole wallet, real funds included. Only enter it on sites you trust.';
}
