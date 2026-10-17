import type { PollKey } from './pollKey';

/**
 * How a contested index is resolved, from the contract's index definition
 * (`contested.resolution`):
 * - 0 `MasternodeVote`: contender, abstain or lock (DPNS).
 * - 1 `MasternodeVoteNoLocking`: no Lock (refused with 40307); there is always
 *   a winner, ties go to the earliest contender (moderator elections).
 */
export type Resolution = 0 | 1;

/** What a masternode can vote for. */
export type VoteChoice =
  | { type: 'identity'; identityId: string }
  | { type: 'abstain' }
  | { type: 'lock' };

export type VoteChoiceKind = VoteChoice['type'];

export function voteChoicesEqual(a: VoteChoice, b: VoteChoice): boolean {
  return (
    a.type === b.type &&
    (a.type !== 'identity' || a.identityId === (b as { identityId: string }).identityId)
  );
}

/** The choices a resolution allows. */
export function choicesForResolution(resolution: Resolution | undefined): VoteChoiceKind[] {
  return resolution === 1 ? ['identity', 'abstain'] : ['identity', 'abstain', 'lock'];
}

export interface Contender {
  identityId: string;
  votes: number;
  /**
   * The contender's document, decoded through the SDK (`Document.toJSON`)
   * when the vote state carried it. Decided contests no longer carry it.
   */
  document?: Record<string, unknown>;
}

export interface Tally {
  /** Sorted by votes, highest first. */
  contenders: Contender[];
  abstain: number;
  lock: number;
  total: number;
}

export interface Winner {
  /** 'identity' when awarded; 'locked'; or the SDK's kind string otherwise. */
  kind: 'identity' | 'locked' | 'other';
  identityId?: string;
  /** The SDK's raw winner kind (e.g. "WonByIdentity", "Locked"). */
  rawKind: string;
  decidedAtMs?: number;
}

/**
 * - open: voting is running (end in the future, no winner yet)
 * - closing: the end passed, Platform has not finalized it yet
 * - decided: a winner (or lock) is recorded
 * - unknown: no end time and no winner known (e.g. an archive entry whose
 *   state has not loaded, or a failed end-time read)
 */
export type Phase = 'open' | 'closing' | 'decided' | 'unknown';

/** A contest summary as discovery lists it, before its vote state loads. */
export interface ContestSummary {
  key: PollKey;
  /** encodePollKey(key), precomputed: the identity used everywhere. */
  keyString: string;
  /** From votePollsByEndDate; absent for archive entries. */
  endsAtMs?: number;
}

/** A contest with its vote state. */
export interface Contest extends ContestSummary {
  tally: Tally;
  winner?: Winner;
  /** From the contract's index definition; undefined if it could not be read. */
  resolution?: Resolution;
}

export function phaseOf(
  c: { endsAtMs?: number; winner?: Winner },
  now = Date.now(),
): Phase {
  if (c.winner) return 'decided';
  if (c.endsAtMs === undefined) return 'unknown';
  return c.endsAtMs > now ? 'open' : 'closing';
}

/** True when the vote state says nobody ever contested this resource. */
export function isEmptyContest(c: Contest): boolean {
  return c.tally.contenders.length === 0 && c.tally.total === 0 && !c.winner;
}
