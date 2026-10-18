import type { EvoSDK } from '@dashevo/evo-sdk';
import { splitText, type CharterProposal, type CharterReason, type JoinRequestMeta } from '../../charters/documents';
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
import { IdentityName } from '../components/IdentityName';
import { ReadIssues } from '../components/ReadIssues';
import { endDate, plural } from '../format';
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
      <div className="contest-page">
        {back}
        {view.status === 'loading' ? (
          <p className="page-note">Reading the proposal…</p>
        ) : (
          <p className="page-note error">Could not read the proposal: {view.message}</p>
        )}
      </div>
    );
  }

  const v = view.value;
  const p = v.proposal;
  if (!p) {
    return (
      <div className="contest-page">
        {back}
        <p className="page-note error">There is no proposal with this id on {network}.</p>
      </div>
    );
  }
  if (p.targetContractId !== target) {
    return (
      <div className="contest-page">
        {back}
        <p className="page-note error">
          This proposal is for another contract. <a href={proposalHref(p.targetContractId, p.id)}>Open it there →</a>
        </p>
      </div>
    );
  }

  const contender = v.status.contest?.tally.contenders.find((c) => c.identityId === p.leaderId);
  const seated = v.status.team;
  const isLeader = session?.identityId === p.leaderId;
  return (
    <div className="contest-page">
      {back}
      <header className="contest-header">
        <h1 className="contest-title">
          <span className="kind-title">
            Proposal by <IdentityName sdk={sdk} id={p.leaderId} />
          </span>
        </h1>
        <p className="mono-label poll-meta">
          charter {p.id}
          {p.createdAtMs ? ` · filed ${endDate(p.createdAtMs)}` : ''}
        </p>
      </header>
      <ReadIssues failures={v.failures} caps={v.caps} />
      {seated?.submittedCharterId === p.id && <p className="page-note ok">This team holds the seat.</p>}
      {seated && seated.submittedCharterId !== p.id && (
        <p className="page-note">Another team holds this contract&apos;s seat, permanently on protocol 14.</p>
      )}
      {contender && !seated && (
        <p className="page-note">
          This team has applied for the seat: {plural(contender.votes, 'vote')} so far.
        </p>
      )}

      <section className="charter-card">
        <h2 className="section-title">Charter</h2>
        <p className="charter-description">{p.description}</p>
        <dl className="kv-table">
          <div>
            <dt className="mono-label">moderators&apos; share</dt>
            <dd>{p.moderatorsShare}% of each declared moderators fee</dd>
          </div>
          <div>
            <dt className="mono-label">reward split</dt>
            <dd>{splitText(p.rewardSplit)}</dd>
          </div>
        </dl>
        <h3>Reasons the team may act on</h3>
        {p.reasonIds.length === 0 && <p className="mono-label">None: this team could take no ban, suspension, warning or deletion.</p>}
        <ul className="reason-list">
          {v.reasons.map((r) => (
            <li key={r.id}>
              <strong className="mono">{r.code}</strong> {r.label}
              {r.description && <span className="fine-print"> — {r.description}</span>}
            </li>
          ))}
          {v.missingReasons.map((id) => (
            <li key={id} className="mono-label error">
              reason {id} not found
            </li>
          ))}
        </ul>
        <CharterNotices />
      </section>

      <section className="charter-card">
        <h2 className="section-title">People who asked to join · {v.joinRequests.length}</h2>
        <p className="fine-print">Only the leader can read their messages.</p>
        <ul className="joiner-list">
          {v.joinRequests.map((r) => (
            <li key={r.id}>
              <IdentityName sdk={sdk} id={r.memberId} />
              {r.createdAtMs && <span className="mono-label"> · {endDate(r.createdAtMs)}</span>}
            </li>
          ))}
        </ul>
      </section>

      {!seated && (
        <section className="charter-card">
          {!session ? (
            <>
              <h2 className="section-title">Take part</h2>
              <p>Sign in to ask to join this team, or, as its leader, to apply for the seat.</p>
              <SignInPanel network={network} />
            </>
          ) : isLeader ? (
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
          ) : (
            <>
              <h2 className="section-title">Ask to join this team</h2>
              <JoinPanel handle={handle} session={session} proposal={p} joinRequests={v.joinRequests} onJoined={view.reload} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
