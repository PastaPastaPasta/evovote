import type { EvoSDK } from '@dashevo/evo-sdk';
import type { CharterProposal, CharterReason, JoinRequestMeta } from '../../charters/documents';
import { moderatedHref, proposalHref } from '../../charters/pollKey';
import {
  fetchElectionStatus,
  fetchJoinRequests,
  fetchProposal,
  fetchReasons,
  type ElectionStatus,
} from '../../charters/reads';
import type { Cap, Failure } from '../../discovery/types';
import { useIdentitySession } from '../../identity/session';
import { targetName } from '../../kinds/charter';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import { CharterNotices } from '../charters/CharterNotices';
import { JoinPanel } from '../charters/JoinPanel';
import { LeaderDashboard } from '../charters/LeaderDashboard';
import { OPEN_PHASES, proposalStanding, splitSentence, viewerNote } from '../charters/standing';
import { CopyButton } from '../components/CopyButton';
import { IdentityName } from '../components/IdentityName';
import { ReadIssues } from '../components/ReadIssues';
import { dateText, firstSentence, shortId } from '../format';
import { SignInPanel } from '../identity/SignInPanel';
import { useAsync } from '../useAsync';

interface ProposalView {
  proposal?: CharterProposal;
  reasons: CharterReason[];
  missingReasons: string[];
  joinRequests: JoinRequestMeta[];
  status: ElectionStatus;
  failures: Failure[];
  caps: Cap[];
}

async function loadProposal(sdk: EvoSDK, target: string, id: string): Promise<ProposalView> {
  const failures: Failure[] = [];
  const caps: Cap[] = [];
  const [proposal, joins, status] = await Promise.all([
    fetchProposal(sdk, id),
    fetchJoinRequests(sdk, id).catch((e: unknown) => {
      failures.push({ source: 'the join requests', message: errorMessage(e) });
      return { requests: [] as JoinRequestMeta[], capped: false };
    }),
    fetchElectionStatus(sdk, target, { force: true }),
  ]);
  if (joins.capped) caps.push({ source: 'join requests', limit: joins.requests.length });
  let reasons: CharterReason[] = [];
  let missingReasons: string[] = [];
  if (proposal) {
    try {
      ({ reasons, missing: missingReasons } = await fetchReasons(sdk, proposal.reasonIds));
    } catch (e) {
      failures.push({ source: 'the reasons', message: errorMessage(e) });
    }
  }
  return {
    proposal,
    reasons,
    missingReasons,
    joinRequests: joins.requests,
    status,
    failures: [...status.failures, ...failures],
    caps,
  };
}

/** `#/m/<target>/charter/<id>`: one proposal, joining it, and (for its leader) applying with it. */
export function ProposalPage({ handle, target, charterId }: { handle: SdkHandle; target: string; charterId: string }) {
  const { sdk, network } = handle;
  const view = useAsync(() => loadProposal(sdk, target, charterId), [sdk, target, charterId]);
  const session = useIdentitySession();

  const back = (
    <a href={moderatedHref(target)} className="back-link">
      ← Moderators of {targetName(target)}
    </a>
  );
  if (view.status !== 'ok') {
    return (
      <div className="contest-page proposal-page">
        <header className="page-header">
          {back}
          <h1 className="page-title">Proposal</h1>
        </header>
        {view.status === 'loading' ? (
          <p className="page-note" role="status">
            Reading the proposal from Platform…
          </p>
        ) : (
          <div className="page-note error" role="alert">
            <p>Could not read this proposal.</p>
            <details className="technical">
              <summary>Technical detail</summary>
              <p className="mono">{view.message}</p>
            </details>
            <button className="vote-button ghost" onClick={view.reload}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const v = view.value;
  const p = v.proposal;
  if (!p || p.targetContractId !== target) {
    return (
      <div className="contest-page proposal-page">
        <header className="page-header">
          {back}
          <h1 className="page-title">Proposal not found</h1>
        </header>
        <p className="page-note error">
          {!p ? (
            `There is no proposal with this id on ${network}.`
          ) : (
            <>
              This proposal is for another contract. <a href={proposalHref(p.targetContractId, p.id)}>Open it there →</a>
            </>
          )}
        </p>
      </div>
    );
  }

  const seated = v.status.team;
  const standing = proposalStanding(v.status, p);
  const isLeader = session?.identityId === p.leaderId;
  const myJoin = session ? v.joinRequests.find((r) => r.memberId === session.identityId) : undefined;
  const note = viewerNote({
    standing,
    role: isLeader ? 'leader' : myJoin ? 'joiner' : 'other',
    onSeatedTeam: !!session && !!seated?.members.includes(session.identityId),
  });
  const open = OPEN_PHASES.has(v.status.timing.phase);
  // The leader reads the join requests in the dashboard; nobody needs them twice.
  const leaderDashboard = isLeader && standing.kind === 'not-applied' && !seated;
  return (
    <div className="contest-page proposal-page">
      <header className="page-header">
        {back}
        <h1 className="page-title">{firstSentence(p.description)}</h1>
        <p className="page-byline">
          <span>
            Proposal by <IdentityName sdk={sdk} id={p.leaderId} />
          </span>
          {p.createdAtMs && <span>Filed {dateText(p.createdAtMs)}</span>}
        </p>
      </header>
      <ReadIssues failures={v.failures} caps={v.caps} />
      <p className={`status-banner tone-${note.tone}`} role="status">
        {note.text}
      </p>

      <section className="hub-section">
        <h2 className="section-title">The charter</h2>
        <p className="charter-description">{p.description}</p>
        <dl className="kv-table">
          <div>
            <dt>Share of moderation fees</dt>
            <dd>
              {p.moderatorsShare}% of each moderation fee the contract declares
              {p.moderatorsShare === 0 && ' (the team moderates for free)'}
            </dd>
          </div>
          <div>
            <dt>How payouts are split</dt>
            <dd>{splitSentence(p.rewardSplit)}</dd>
          </div>
        </dl>
      </section>

      <section className="hub-section">
        <h2 className="section-title">Reasons the team may act on · {p.reasonIds.length}</h2>
        <p className="meta">Every ban, suspension, warning or deletion the team makes must cite one of these.</p>
        {p.reasonIds.length === 0 && (
          <p>None: this team could not ban, suspend, warn or delete anything.</p>
        )}
        <ul className="reason-list">
          {v.reasons.map((r) => (
            <li key={r.id}>
              <span className="reason-code mono">{r.code}</span>
              <span>
                <strong>{r.label}</strong>
                {r.description && <span className="meta"> — {r.description}</span>}
              </span>
            </li>
          ))}
          {v.missingReasons.map((id) => (
            <li key={id} className="meta error">
              A cited reason could not be found ({shortId(id)}).
            </li>
          ))}
        </ul>
      </section>

      {!leaderDashboard && (
        <section className="hub-section">
          <h2 className="section-title">People who asked to join · {v.joinRequests.length}</h2>
          <p className="meta">
            {standing.kind === 'not-applied'
              ? 'Their messages are encrypted: only the leader can read them. The leader picks members from this list when applying.'
              : 'Their messages are encrypted: only the leader can read them.'}
          </p>
          {v.joinRequests.length === 0 ? (
            <p>Nobody has asked to join.</p>
          ) : (
            <ul className="joiner-list">
              {v.joinRequests.map((r) => (
                <li key={r.id}>
                  <IdentityName sdk={sdk} id={r.memberId} />
                  {seated?.submittedCharterId === p.id && seated.members.includes(r.memberId) && (
                    <span className="chip tone-won">on the team</span>
                  )}
                  {r.createdAtMs && <span className="meta"> · asked {dateText(r.createdAtMs, { time: false })}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!seated && open && (!session || leaderDashboard || (!isLeader && !myJoin)) && (
        <section className="hub-section take-part">
          {!session ? (
            <>
              <h2 className="section-title">Take part</h2>
              <p>
                {standing.kind === 'not-applied'
                  ? 'Sign in with your Dash identity to ask to join this team, or, if you lead it, to apply for the seat.'
                  : 'Sign in with your Dash identity to see where you stand.'}
              </p>
              <SignInPanel network={network} />
            </>
          ) : leaderDashboard ? (
            <>
              <h2 className="section-title">Your team</h2>
              <LeaderDashboard
                handle={handle}
                session={session}
                proposal={p}
                joinRequests={v.joinRequests}
                onApplied={view.reload}
              />
            </>
          ) : standing.kind === 'not-applied' ? (
            <>
              <h2 className="section-title">Ask to join this team</h2>
              <JoinPanel handle={handle} session={session} proposal={p} joinRequests={v.joinRequests} onJoined={view.reload} />
            </>
          ) : (
            <p className="meta">
              This team has already applied with the members its leader chose, so a new request to join would not
              count.
            </p>
          )}
        </section>
      )}

      {open && <CharterNotices />}

      <p className="meta page-foot">
        Proposal <span className="mono" title={p.id}>{shortId(p.id)}</span> <CopyButton text={p.id} label="Copy proposal id" />
      </p>
    </div>
  );
}
