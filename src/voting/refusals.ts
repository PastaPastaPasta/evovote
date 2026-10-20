import { errorCode, errorMessage } from '../sdk/errors';

/**
 * Consensus refusal codes a vote or a moderator-election write can earn, in
 * plain words. Codes from rs-dpp `errors/consensus/codes.rs` at v5.0.0-rc.4.
 */
export const REFUSALS: Readonly<Record<number, string>> = {
  10421: 'A text is longer than Platform allows (counted in bytes).',
  10422: 'The reward split does not add up to 100.',
  11000: 'A charter field is missing or has the wrong type.',
  20004: 'This key cannot sign this: its security level is not allowed here.',
  20005: 'This key cannot sign this: it has the wrong purpose. Use an authentication key.',
  20007: 'This key cannot sign this: use a HIGH or CRITICAL authentication key.',
  30000: 'The identity does not have enough credits to pay for this.',
  40100: 'That document already exists.',
  40112: 'This identity has already applied in this contest; each identity can apply once.',
  40114: 'The application did not carry the contest fund it must pay.',
  40120:
    'Something it refers to does not exist: the target contract, a reason, the proposal, or a member who has not asked to join.',
  40123:
    'A key it refers to does not exist: the leader has no decryption key for join requests, or you have no encryption key for them.',
  40124: 'A key it refers to is disabled.',
  40135:
    'The target contract does not qualify: it does not declare elected moderation, or its election delay has not passed yet.',
  40136:
    'A key it refers to is the wrong kind: the leader needs a decryption key bound to submittedCharter, a member an encryption key bound to joinRequest.',
  40141: 'This contest already has the most contenders it can hold.',
  40205: 'This identity already holds the most keys Platform allows.',
  40206: 'That key is already on an identity.',
  40207: 'That key id is already used on this identity.',
  40210: "The identity's balance is too low for this.",
  40211: 'This identity already has a key with exactly these contract bounds.',
  41203: "A moderation action must cite a reason the seated team's charter lists.",
  40111:
    'The contest is no longer accepting new contenders: its join window has closed.',
  40105: 'That resource is already taken. A moderator seat is permanent once awarded.',
  40110: 'This contest is locked: masternodes voted to award it to no one.',
  40204: 'Another transition from this masternode was in flight. Wait a moment and retry.',
  40300:
    'Platform does not know this masternode. Check the ProTxHash, and that the node is registered and not banned.',
  40301: 'Platform has no vote poll for this contest. It may never have opened.',
  40302:
    'Voting on this contest is closed: it was awarded or locked, or it has not started.',
  40303:
    'This masternode has used all 5 of its votes on this contest. Its current vote stands.',
  40304: 'This masternode already votes for this choice, so nothing changed.',
  40305: "This key is not the masternode's registered voting key.",
  40306: 'The voter identity does not match this masternode and key.',
  40307:
    'That choice is not allowed in this contest: Lock is not offered here, or the identity is not a contender.',
  40400: "This contest's vote fund is spent, so it cannot pay for more votes.",
  40401:
    "This contest's vote fund was not found: the vote addressed a poll that does not exist (often one rebuilt with the wrong value types).",
};

export interface DescribedError {
  /** The consensus code, when there is one. */
  code?: number;
  /** Plain-language explanation. */
  message: string;
  /** The SDK's own message, for the curious and for bug reports. */
  detail: string;
}

/**
 * Turn any SDK error from a vote into plain words plus the raw detail. The
 * message follows "Not recorded:" or "Platform refused it:", so an unknown
 * code reads as a clause.
 */
export function describeVoteError(e: unknown): DescribedError {
  const detail = errorMessage(e);
  const code = errorCode(e);
  if (code === undefined) return { message: detail, detail };
  const known = REFUSALS[code];
  if (known) return { code, message: known, detail };
  // An unknown code stays out of the message; the detail (shown folded) carries it.
  return {
    code,
    message: 'for a reason this site does not recognise (see the technical detail).',
    detail: detail.includes(String(code)) ? detail : `${detail} (consensus error ${code})`,
  };
}

/** The same, for a document or identity write. */
export const describeWriteError = describeVoteError;
