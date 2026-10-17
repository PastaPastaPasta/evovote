import { electedOf, electionOpensAtMs, type ContractModeration } from './declaration';

/**
 * Where a contract's moderator election stands:
 *
 * - not-elected: the contract does not declare elected moderation (a charter
 *   for it is refused with 40135)
 * - notice: elected, but its election delay has not passed; proposals may be
 *   filed, applications (electedCharter) are refused with 40135
 * - no-election: nothing filed yet
 * - proposals: proposals filed, nobody has applied for the seat
 * - join-window: a contest is open and new applicants can still join
 * - voting: the join window closed; masternodes vote until the end
 * - closing: the end passed; Platform has not recorded the result yet
 * - decided: a winner is recorded, the team has not been read
 * - seated: a team holds the seat (permanent on protocol 14)
 * - unknown: a read this depends on failed
 */
export type ElectionPhase =
  | 'not-elected'
  | 'notice'
  | 'no-election'
  | 'proposals'
  | 'join-window'
  | 'voting'
  | 'closing'
  | 'decided'
  | 'seated'
  | 'unknown';

/** A read result: the value, or 'failed' (never mistaken for "none"). */
export type Read<T> = T | 'failed';

export interface PhaseInput {
  moderation: Read<ContractModeration | undefined>;
  /** Whether a team is seated. */
  seated: Read<boolean>;
  /** The contest for the seat, undefined when nobody applied. */
  contest: Read<{ contenders: number; hasWinner: boolean } | undefined>;
  /** The contest's end from the end-date index, when it is there. */
  endsAtMs?: number;
  proposals: Read<number>;
}

export interface ElectionTiming {
  phase: ElectionPhase;
  /** When applications open (election delay), if one is declared. */
  opensAtMs?: number;
  /** When the join window closes, if a contest is open and its end is known. */
  joinClosesAtMs?: number;
  endsAtMs?: number;
}

export const PHASE_TEXT: Record<ElectionPhase, string> = {
  'not-elected': 'Not an elected contract',
  notice: 'Election not open yet',
  'no-election': 'No election yet',
  proposals: 'Proposals filed',
  'join-window': 'Applications open',
  voting: 'Voting',
  closing: 'Voting closed, awaiting result',
  decided: 'Decided',
  seated: 'Team seated',
  unknown: 'Unknown',
};

/**
 * When the join window of an open contest closes. A lone applicant is
 * awarded when the join window closes, so the poll's end IS the close; once
 * a second applicant joins, the end moves to join + vote, so the close is
 * the end less the vote window.
 */
export function joinClosesAt(
  endsAtMs: number,
  contenders: number,
  voteWindowSeconds: number,
): number {
  return contenders >= 2 ? endsAtMs - voteWindowSeconds * 1000 : endsAtMs;
}

/** Pure: the phase and its times. A phase is only claimed when its reads succeeded. */
export function electionTiming(input: PhaseInput, now = Date.now()): ElectionTiming {
  const { moderation, seated, contest, proposals, endsAtMs } = input;
  if (moderation === 'failed') return { phase: 'unknown' };
  const elected = moderation ? electedOf(moderation) : undefined;
  if (!moderation || !elected) return { phase: 'not-elected' };
  const opensAtMs = electionOpensAtMs(moderation);

  if (seated === true) return { phase: 'seated', opensAtMs };
  if (seated === 'failed') return { phase: 'unknown', opensAtMs };

  if (contest === 'failed') return { phase: 'unknown', opensAtMs };
  if (contest && contest.hasWinner) return { phase: 'decided', opensAtMs };
  if (contest && contest.contenders > 0) {
    if (endsAtMs === undefined) return { phase: 'voting', opensAtMs };
    const close = joinClosesAt(endsAtMs, contest.contenders, elected.voteWindowSeconds);
    const phase: ElectionPhase =
      now < close ? 'join-window' : now < endsAtMs ? 'voting' : 'closing';
    return { phase, opensAtMs, joinClosesAtMs: close, endsAtMs };
  }

  if (opensAtMs !== undefined && now < opensAtMs) return { phase: 'notice', opensAtMs };
  if (proposals === 'failed') return { phase: 'unknown', opensAtMs };
  return { phase: proposals > 0 ? 'proposals' : 'no-election', opensAtMs };
}

/**
 * Whether a new application (electedCharter) can be filed now, and if not,
 * why, in plain words with the refusal it would earn. Checked before anyone
 * pays: a refused application still pays its fees.
 */
export type ApplyCheck =
  | { ok: true; warning?: string }
  | { ok: false; reason: string; code?: number };

/** Applications closer than this to the join window's close get a warning. */
export const LATE_APPLY_MARGIN_MS = 10 * 60_000;

export function canApply(timing: ElectionTiming, now = Date.now()): ApplyCheck {
  switch (timing.phase) {
    case 'not-elected':
      return {
        ok: false,
        code: 40135,
        reason: 'This contract does not declare elected moderation, so no team can apply.',
      };
    case 'notice':
      return {
        ok: false,
        code: 40135,
        reason:
          timing.opensAtMs === Number.POSITIVE_INFINITY
            ? 'This contract declares an election delay but has no recorded creation time, so its election never opens.'
            : `Applications open ${new Date(timing.opensAtMs ?? 0).toLocaleString()}; until then Platform refuses them.`,
      };
    case 'seated':
    case 'decided':
      return {
        ok: false,
        code: 40105,
        reason: 'The seat is taken. On protocol 14 a seat is permanent, and another application is refused but still paid.',
      };
    case 'unknown':
      return {
        ok: false,
        reason: 'The election state could not be read, so it is not safe to apply. Reload and try again.',
      };
    case 'voting':
    case 'closing':
      if (timing.joinClosesAtMs === undefined && timing.phase === 'voting') {
        return {
          ok: true,
          warning:
            'A contest is open but its end time could not be read, so it is unknown whether the join window is still open. A late application is refused (40111) and still pays its fees.',
        };
      }
      return {
        ok: false,
        code: 40111,
        reason: 'The join window of the open contest has closed. A late application is refused but still pays its fees.',
      };
    case 'join-window': {
      const left = (timing.joinClosesAtMs ?? 0) - now;
      return left < LATE_APPLY_MARGIN_MS
        ? {
            ok: true,
            warning: `The join window closes in under ${Math.max(1, Math.ceil(left / 60_000))} minute(s). If the block that includes your application comes after it, Platform refuses it (40111) and you still pay the fees.`,
          }
        : { ok: true };
    }
    case 'no-election':
    case 'proposals':
      return { ok: true };
  }
}
