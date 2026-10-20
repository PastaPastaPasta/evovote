import { toElectedCharter, type CharterProposal } from '../../charters/documents';
import type { ElectionPhase } from '../../charters/phase';
import { pickLeaderProposal, type ElectionStatus } from '../../charters/reads';
import { firstSentence, plural } from '../format';

/**
 * A team's name: its charter's title (the first sentence), as the proposal
 * list shows it. Undefined for a charter with no text.
 */
export function teamName(description: string): string | undefined {
  return firstSentence(description).replace(/[!?]+$/, '') || undefined;
}

/**
 * The name of the team a contender (or the seated leader) stands for: the
 * seated proposal, else the one the application names, else (decided) the
 * leader's latest proposal before the decision. Undefined when none of the
 * read proposals is it; pages then name the leader.
 */
export function contenderTeamName(
  status: Pick<ElectionStatus, 'targetContractId' | 'team' | 'contest' | 'proposals'>,
  leaderId: string,
): string | undefined {
  const { team, contest, proposals } = status;
  const byId = (id: string | undefined) => (id ? proposals.find((p) => p.id === id) : undefined);
  // The seated team is named by its own proposal only: past a capped list, another title would be a guess.
  if (team?.leaderId === leaderId) {
    const seated = byId(team.submittedCharterId);
    return seated ? teamName(seated.description) : undefined;
  }
  let proposal: CharterProposal | undefined;
  const contender = contest?.tally.contenders.find((c) => c.identityId === leaderId);
  proposal ??= byId(appliedWith(contender?.document));
  const decidedAtMs = contest?.winner?.decidedAtMs;
  if (!proposal && contender && decidedAtMs !== undefined) {
    const own = proposals.filter((p) => p.leaderId === leaderId);
    proposal = pickLeaderProposal(own, status.targetContractId, decidedAtMs).proposal;
  }
  return proposal && proposal.leaderId === leaderId ? teamName(proposal.description) : undefined;
}

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
 * - not-applied: nobody has applied with it yet, and teams still can
 * - other-proposal: its leader applied with another of their proposals (an identity applies once)
 * - closed: it never applied, and applications are closed (or the seat taken)
 * - unknown: a read it depends on failed, so none of the above can be said
 *
 * Contenders are identities. While the vote runs, a contender's application
 * names its proposal, so a leader's other proposals are told apart; once
 * decided, every proposal of a losing leader shares the leader's standing.
 */
export type Standing =
  | { kind: 'seated'; votes?: number; share?: number }
  | { kind: 'lost'; votes: number; share?: number }
  | { kind: 'applied'; votes: number; share?: number }
  | { kind: 'not-applied' }
  | { kind: 'other-proposal' }
  | { kind: 'closed' }
  | { kind: 'unknown' };

/** Reads whose failure leaves a proposal's standing unknown. */
const STANDING_SOURCES = ['the seated team', 'the contest for the seat'];

/** The proposal a running contender applied with, when its application is in the vote state. */
function appliedWith(document: Record<string, unknown> | undefined): string | undefined {
  if (!document) return undefined;
  try {
    return toElectedCharter(document).submittedCharterId || undefined;
  } catch {
    return undefined;
  }
}

/** Pure: one proposal's standing from the election status. */
export function proposalStanding(
  status: Pick<ElectionStatus, 'team' | 'contest'> & Partial<Pick<ElectionStatus, 'timing' | 'failures'>>,
  proposal: Pick<CharterProposal, 'id' | 'leaderId'>,
): Standing {
  const { team, contest } = status;
  if (status.timing?.phase === 'unknown' || status.failures?.some((f) => STANDING_SOURCES.includes(f.source))) {
    return { kind: 'unknown' };
  }
  const total = contest?.tally.total ?? 0;
  const contender = contest?.tally.contenders.find((c) => c.identityId === proposal.leaderId);
  const share = contender && total > 0 ? Math.round((contender.votes / total) * 100) : undefined;
  if (team?.submittedCharterId === proposal.id) return { kind: 'seated', votes: contender?.votes, share };
  const decided = !!team || !!contest?.winner;
  const applicationsClosed = decided || status.timing?.phase === 'voting' || status.timing?.phase === 'closing';
  const other = appliedWith(contender?.document);
  if (contender && (other === undefined || other === proposal.id)) {
    // The seated leader's other proposals: the seat was won with another one.
    if (team?.leaderId === proposal.leaderId) return { kind: 'other-proposal' };
    const won = contest?.winner?.identityId === proposal.leaderId && !team;
    if (won) return { kind: 'seated', votes: contender.votes, share };
    return decided ? { kind: 'lost', votes: contender.votes, share } : { kind: 'applied', votes: contender.votes, share };
  }
  // The leader applied with another of their proposals (an identity applies once).
  if (contender) return { kind: 'other-proposal' };
  return applicationsClosed ? { kind: 'closed' } : { kind: 'not-applied' };
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
    case 'other-proposal':
      return { text: 'leader applied with another', tone: 'muted' };
    case 'closed':
      return { text: 'did not apply', tone: 'muted' };
    case 'unknown':
      return { text: 'standing unknown', tone: 'muted' };
  }
}

/** "12 votes (75%)", or "12 votes" when there is no total to compare with. */
export function votesText(votes: number, share: number | undefined): string {
  return share === undefined ? plural(votes, 'vote') : `${plural(votes, 'vote')} (${share}%)`;
}

/** The seated leader's tally against the rest: "12–4", or "unopposed". Undefined if they were not a contender. */
export function winningScore(contenders: ReadonlyArray<{ identityId: string; votes: number }>, leaderId: string): string | undefined {
  const winner = contenders.find((c) => c.identityId === leaderId);
  if (!winner) return undefined;
  const rest = contenders.filter((c) => c.identityId !== leaderId);
  return rest.length > 0 ? [winner, ...rest].map((c) => c.votes).join('–') : 'unopposed';
}

/**
 * The banner at the top of a proposal: where it stands, said to whoever is
 * looking (its leader, someone who asked to join, or anyone else).
 */
export function viewerNote(args: {
  standing: Standing;
  role: 'leader' | 'joiner' | 'other';
  /**
   * For a joiner of the winning team: whether the seated team lists them.
   * Undefined when the seated team has not been read.
   */
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
              ? args.onSeatedTeam === undefined
                ? 'You asked to join this team, and it won the seat.'
                : args.onSeatedTeam
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
    case 'other-proposal':
      return {
        tone: 'muted',
        text:
          role === 'leader'
            ? 'You applied for the seat with another of your proposals. An identity applies only once, so this one cannot apply.'
            : role === 'joiner'
              ? 'You asked to join this team, but its leader applied for the seat with another of their proposals.'
              : "This team's leader applied for the seat with another of their proposals, so this one cannot apply.",
      };
    case 'closed':
      return {
        tone: 'muted',
        text:
          role === 'leader'
            ? 'You did not apply with this proposal, and applications are now closed.'
            : role === 'joiner'
              ? 'You asked to join this team, but it did not apply for the seat, and applications are now closed.'
              : 'This team did not apply for the seat, and applications are now closed.',
      };
    case 'unknown':
      return {
        tone: 'muted',
        text: 'Where this team stands could not be read right now. Reload the page to try again.',
      };
  }
}

/** "40% to the leader, 30% shared equally, 30% by actions taken." */
export function splitSentence(split: { leader: number; equal: number; actions: number } | undefined): string {
  if (!split) return 'Could not be read.';
  return `${split.leader}% to the leader, ${split.equal}% shared equally by the team, ${split.actions}% by how many actions each member took.`;
}
