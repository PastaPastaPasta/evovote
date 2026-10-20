import type { CharterProposal } from '../../charters/documents';
import type { ElectionPhase } from '../../charters/phase';
import type { ElectionStatus } from '../../charters/reads';
import { plural } from '../format';

/** Phases in which teams can still propose, apply or be voted on. */
export const OPEN_PHASES: ReadonlySet<ElectionPhase> = new Set<ElectionPhase>([
  'notice',
  'no-election',
  'proposals',
  'join-window',
  'voting',
  'closing',
]);

/** How a phase is coloured: a filled seat, a live election, or neither. */
export function phaseTone(phase: ElectionPhase | undefined): 'won' | 'live' | 'muted' {
  if (phase === 'seated' || phase === 'decided') return 'won';
  return phase && OPEN_PHASES.has(phase) ? 'live' : 'muted';
}

/**
 * Where one proposal stands in its contract's election:
 *
 * - seated: its team holds the seat
 * - lost: its leader applied and the seat went to another team
 * - applied: its leader is a contender in the running vote
 * - not-applied: nobody has applied with it (yet, while the election is open)
 * - closed: it never applied and the seat is taken
 *
 * Contenders are identities, so a leader's standing is shared by every
 * proposal that leader filed, except the one the seated team names.
 */
export type Standing =
  | { kind: 'seated'; votes?: number; share?: number }
  | { kind: 'lost'; votes: number; share?: number }
  | { kind: 'applied'; votes: number; share?: number }
  | { kind: 'not-applied' }
  | { kind: 'closed' };

/** Pure: one proposal's standing from the election status. */
export function proposalStanding(
  status: Pick<ElectionStatus, 'team' | 'contest'>,
  proposal: Pick<CharterProposal, 'id' | 'leaderId'>,
): Standing {
  const { team, contest } = status;
  const total = contest?.tally.total ?? 0;
  const contender = contest?.tally.contenders.find((c) => c.identityId === proposal.leaderId);
  const share = contender && total > 0 ? Math.round((contender.votes / total) * 100) : undefined;
  if (team?.submittedCharterId === proposal.id) return { kind: 'seated', votes: contender?.votes, share };
  const decided = !!team || !!contest?.winner;
  if (contender) {
    // The seated leader's other proposals: the seat was won with another one.
    if (team?.leaderId === proposal.leaderId) return { kind: 'closed' };
    const won = contest?.winner?.identityId === proposal.leaderId && !team;
    if (won) return { kind: 'seated', votes: contender.votes, share };
    return decided ? { kind: 'lost', votes: contender.votes, share } : { kind: 'applied', votes: contender.votes, share };
  }
  return decided ? { kind: 'closed' } : { kind: 'not-applied' };
}

/** The chip a proposal row shows: "won · seated", "lost · 4 votes", "applied · 12 votes", "not applied". */
export function standingChip(s: Standing): { text: string; tone: 'won' | 'lost' | 'live' | 'muted' } {
  switch (s.kind) {
    case 'seated':
      return { text: 'won · seated', tone: 'won' };
    case 'lost':
      return { text: `lost · ${plural(s.votes, 'vote')}`, tone: 'lost' };
    case 'applied':
      return { text: `applied · ${plural(s.votes, 'vote')}`, tone: 'live' };
    case 'not-applied':
      return { text: 'not applied', tone: 'muted' };
    case 'closed':
      return { text: 'did not apply', tone: 'muted' };
  }
}

/** "12 votes (75%)", or "12 votes" when there is no total to compare with. */
export function votesText(votes: number, share: number | undefined): string {
  return share === undefined ? plural(votes, 'vote') : `${plural(votes, 'vote')} (${share}%)`;
}

/**
 * The banner at the top of a proposal: where it stands, said to whoever is
 * looking (its leader, someone who asked to join, or anyone else).
 */
export function viewerNote(args: {
  standing: Standing;
  role: 'leader' | 'joiner' | 'other';
  /** For a joiner of the seated team: whether its leader listed them. */
  onSeatedTeam?: boolean;
}): { tone: 'won' | 'lost' | 'live' | 'muted'; text: string } {
  const { standing: s, role } = args;
  const votes = 'votes' in s && s.votes !== undefined ? votesText(s.votes, s.share) : undefined;
  switch (s.kind) {
    case 'seated':
      return {
        tone: 'won',
        text:
          role === 'leader'
            ? 'Your team won. It holds this seat permanently.'
            : role === 'joiner'
              ? args.onSeatedTeam
                ? 'You are on the seated team. It holds this seat permanently.'
                : 'This team won the seat, but its leader did not list you as a member.'
              : `This team won the election${votes ? ` with ${votes}` : ''} and holds the seat permanently.`,
      };
    case 'lost':
      return {
        tone: 'lost',
        text:
          role === 'leader'
            ? `Your team lost with ${votes}. The seat went to another team, permanently.`
            : role === 'joiner'
              ? `You asked to join this team. It lost the vote with ${votes}.`
              : `This team applied and lost, with ${votes}. Another team holds the seat.`,
      };
    case 'applied':
      return {
        tone: 'live',
        text:
          role === 'leader'
            ? `You have applied for the seat: ${votes} so far.`
            : role === 'joiner'
              ? `You asked to join this team. It has applied, with the members its leader chose: ${votes} so far.`
              : `This team has applied for the seat: ${votes} so far.`,
      };
    case 'not-applied':
      return {
        tone: 'muted',
        text:
          role === 'leader'
            ? 'You lead this proposal and have not applied yet. Choose your members below, then apply for the seat.'
            : role === 'joiner'
              ? 'You asked to join this team. Its leader chooses the members when applying for the seat.'
              : 'This team has not applied for the seat yet.',
      };
    case 'closed':
      return {
        tone: 'muted',
        text:
          role === 'leader'
            ? 'You did not apply with this proposal, and the seat is now filled.'
            : 'This team did not apply, and the seat is now filled by another team.',
      };
  }
}

/** "40% to the leader, 30% shared equally, 30% by actions taken." */
export function splitSentence(split: { leader: number; equal: number; actions: number } | undefined): string {
  if (!split) return 'Could not be read.';
  return `${split.leader}% to the leader, ${split.equal}% shared equally by the team, ${split.actions}% by how many actions each member took.`;
}
