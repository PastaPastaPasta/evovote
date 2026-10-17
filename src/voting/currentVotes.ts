import type { EvoSDK } from '@dashevo/evo-sdk';
import { base58Encode, hexToBytes } from '../model/bytes';
import type { VoteChoice } from '../model/contest';
import { encodePollKey, pollKeyFromSdkPoll, type SdkVotePollLike } from '../model/pollKey';

/** The structural shape of a wasm ResourceVote this module reads. */
export interface ResourceVoteLike {
  poll: SdkVotePollLike & { free?: () => void };
  choice: { toJSON(): unknown; free?: () => void };
  free?: () => void;
}

/** Map a ResourceVoteChoice JSON (`{ $type, identity? }`) to a VoteChoice. */
export function choiceFromJson(json: unknown): VoteChoice | undefined {
  const j = json as { $type?: unknown; identity?: unknown } | null;
  switch (j?.$type) {
    case 'towardsIdentity':
      return typeof j.identity === 'string'
        ? { type: 'identity', identityId: j.identity }
        : undefined;
    case 'abstain':
      return { type: 'abstain' };
    case 'lock':
      return { type: 'lock' };
    default:
      return undefined;
  }
}

/** One ResourceVote to (keyString, choice). Pure; exported for tests. */
export function readResourceVote(
  rv: ResourceVoteLike,
): { keyString: string; choice: VoteChoice } | undefined {
  try {
    const choice = choiceFromJson(rv.choice.toJSON());
    if (!choice) return undefined;
    return { keyString: encodePollKey(pollKeyFromSdkPoll(rv.poll)), choice };
  } catch {
    return undefined;
  } finally {
    try {
      rv.free?.();
    } catch {
      // Already freed.
    }
  }
}

const PAGE = 100;
const MAX_PAGES = 5;

/**
 * A masternode's current vote on every poll it has voted in, by PollKey
 * string. Throws when the read fails: "could not read" must never look like
 * "has not voted".
 *
 * Platform stores these votes under the masternode's ProTxHash, not under
 * its voter identity, so `identityId` here is the ProTxHash (passed as
 * base58 of the Core-order bytes; docs/V2_NOTES.md). The result is the
 * current choice only; how many of the 5 votes were spent is not returned.
 */
export async function readCurrentVotes(
  sdk: EvoSDK,
  proTxHashHex: string,
): Promise<Map<string, VoteChoice>> {
  const identityId = base58Encode(hexToBytes(proTxHashHex));
  const out = new Map<string, VoteChoice>();
  let startAtVoteId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const votes = await sdk.voting.contestedResourceIdentityVotes({
      identityId,
      limit: PAGE,
      ...(startAtVoteId ? { startAtVoteId, startAtIncluded: false } : {}),
    });
    let lastId: string | undefined;
    for (const [voteId, rv] of votes) {
      lastId = voteId;
      const read = readResourceVote(rv as unknown as ResourceVoteLike);
      if (read) out.set(read.keyString, read.choice);
    }
    if (votes.size < PAGE || !lastId) break;
    startAtVoteId = lastId;
  }
  return out;
}
