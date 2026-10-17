import { bytesToBase64Url, sha256 } from '../model/bytes';
import { encodePollKey, type PollKey } from '../model/pollKey';

/**
 * How a contest is addressed in the discussion contract.
 *
 * Platform limits an indexed string to 63 characters, and a canonical poll
 * key is longer than that for every contest (the contract id alone is 44).
 * So the comment carries
 *   - `scope`: base64url(SHA-256(UTF-8 of the canonical key)), always 43
 *     characters. This is what the index and every query use.
 *   - `pollKey`: the canonical key itself, in a non-indexed field, so a
 *     comment says which contest it belongs to without a reverse lookup.
 * Readers keep a comment only when its `pollKey` equals the key they asked
 * for, so a comment cannot claim a contest its readable key does not name.
 */
export interface Scope {
  /** `encodePollKey(key)`. */
  pollKey: string;
  /** The indexed 43-character hash of `pollKey`. */
  scope: string;
}

/** The schema's bounds (contracts/discussion.json). */
export const SCOPE_LENGTH = 43;
export const POLL_KEY_MAX_LENGTH = 1280;

export async function scopeOfKeyString(pollKey: string): Promise<Scope> {
  const digest = await sha256(new TextEncoder().encode(pollKey));
  return { pollKey, scope: bytesToBase64Url(digest) };
}

/**
 * The scope of a contest. Throws when the canonical key is longer than the
 * contract allows (only possible for an index with an extreme number of
 * long values); the UI then shows discussion as unavailable for that contest.
 */
export async function scopeOf(key: PollKey): Promise<Scope> {
  const pollKey = encodePollKey(key);
  if (pollKey.length > POLL_KEY_MAX_LENGTH) {
    throw new Error('This contest\'s key is too long for the discussion contract.');
  }
  return scopeOfKeyString(pollKey);
}
