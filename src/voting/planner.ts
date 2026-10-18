import { voteChoicesEqual, type VoteChoice, type VoteChoiceKind } from '../model/contest';

/** Votes a masternode may cast on one poll, counting the first (40303 past it). */
export const VOTES_PER_POLL = 5;

/** What the planner needs to know about a poll. */
export interface PlanPoll {
  keyString: string;
  /** From the kind adapter: no 'lock' for resolution 1. */
  allowedChoices: VoteChoiceKind[];
  contenderIds: string[];
  /** False once decided: Platform refuses votes (40302). */
  votable: boolean;
}

export interface PlanMasternode {
  id: string;
  proTxHash: string;
  /** A verified voting key is loaded. */
  hasKey: boolean;
}

export type SkipReason =
  | 'no-key'
  | 'closed'
  | 'choice-not-allowed'
  | 'not-contender'
  | 'no-op'
  | 'budget';

export interface PlanItem {
  mnId: string;
  proTxHash: string;
  keyString: string;
  action: 'cast' | 'skip';
  reason?: SkipReason;
  /** The node's current vote on this poll; undefined if none or unknown. */
  current?: VoteChoice;
  /** The current vote could not be read: the plan casts but cannot rule out a no-op. */
  currentUnknown: boolean;
  /**
   * A lower bound on votes already spent here: this browser's receipts, or 1
   * if Platform shows a current vote. Platform does not report the count.
   */
  votesUsedAtLeast: number;
}

export interface PlanInput {
  polls: PlanPoll[];
  masternodes: PlanMasternode[];
  choice: VoteChoice;
  /** Per masternode id: its current votes by key string, or undefined if the read failed. */
  currentVotes: ReadonlyMap<string, ReadonlyMap<string, VoteChoice> | undefined>;
  /** Votes this browser has sent for (proTxHash, keyString). */
  sentCount: (proTxHash: string, keyString: string) => number;
}

/**
 * Plan a batch over polls × masternodes × one choice. Pure. Every pair gets
 * an item: either 'cast' or 'skip' with the reason, so the UI can show what
 * will and will not happen before anything is signed.
 */
export function planVotes(input: PlanInput): PlanItem[] {
  const items: PlanItem[] = [];
  for (const poll of input.polls) {
    for (const mn of input.masternodes) {
      const votes = input.currentVotes.get(mn.id);
      const current = votes?.get(poll.keyString);
      const votesUsedAtLeast = Math.max(
        input.sentCount(mn.proTxHash, poll.keyString),
        current ? 1 : 0,
      );
      const base = {
        mnId: mn.id,
        proTxHash: mn.proTxHash,
        keyString: poll.keyString,
        current,
        currentUnknown: votes === undefined,
        votesUsedAtLeast,
      };
      const skip = (reason: SkipReason): PlanItem => ({ ...base, action: 'skip', reason });
      if (!mn.hasKey) items.push(skip('no-key'));
      else if (!poll.votable) items.push(skip('closed'));
      else if (!poll.allowedChoices.includes(input.choice.type)) items.push(skip('choice-not-allowed'));
      else if (
        input.choice.type === 'identity' &&
        !poll.contenderIds.includes(input.choice.identityId)
      ) {
        items.push(skip('not-contender'));
      } else if (current && voteChoicesEqual(current, input.choice)) items.push(skip('no-op'));
      else if (votesUsedAtLeast >= VOTES_PER_POLL) items.push(skip('budget'));
      else items.push({ ...base, action: 'cast' });
    }
  }
  return items;
}

export const SKIP_TEXT: Readonly<Record<SkipReason, string>> = {
  'no-key': 'no voting key loaded',
  closed: 'voting has closed',
  'choice-not-allowed': 'this contest does not offer that choice',
  'not-contender': 'that identity is not a contender',
  'no-op': 'already votes this way',
  budget: `all ${VOTES_PER_POLL} votes used`,
};
