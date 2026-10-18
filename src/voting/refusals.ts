import { errorCode, errorMessage } from '../sdk/errors';

/**
 * Consensus refusal codes a vote (or, later, a contest write) can earn, in
 * plain words. Codes from rs-dpp `errors/consensus/codes.rs` at v5.0.0-rc.4.
 */
export const REFUSALS: Readonly<Record<number, string>> = {
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

/** Turn any SDK error into plain words plus the raw detail. */
export function describeVoteError(e: unknown): DescribedError {
  const detail = errorMessage(e);
  const code = errorCode(e);
  const known = code !== undefined ? REFUSALS[code] : undefined;
  return {
    code,
    message:
      known ??
      (code !== undefined ? `Platform refused the vote (code ${code}).` : detail),
    detail,
  };
}
