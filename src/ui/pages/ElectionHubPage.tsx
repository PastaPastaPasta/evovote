import { useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { electedOf } from '../../charters/declaration';
import type { CharterProposal } from '../../charters/documents';
import { PHASE_TEXT } from '../../charters/phase';
import { charterPollKey, proposalHref } from '../../charters/pollKey';
import { fetchElectionStatus, type ElectionStatus } from '../../charters/reads';
import { useIdentitySession } from '../../identity/session';
import { targetName } from '../../kinds/charter';
import { encodePollKey } from '../../model/pollKey';
import type { SdkHandle } from '../../sdk/connection';
import { CharterNotices } from '../charters/CharterNotices';
import { CharterWizard } from '../charters/CharterWizard';
import { DeclarationCard, moderatedTypesText } from '../charters/DeclarationCard';
import { ElectionSteps } from '../charters/ElectionSteps';
import { OPEN_PHASES, phaseTone, proposalStanding, standingChip, votesText, winningScore, type Standing } from '../charters/standing';
import { CopyButton } from '../components/CopyButton';
import { IdentityName } from '../components/IdentityName';
import { ReadIssues } from '../components/ReadIssues';
import { TechnicalDetail } from '../components/TechnicalDetail';
import { afterFirstSentence, countdown, dateText, excerpt, firstSentence, plural, shortId } from '../format';
import { useNow } from '../hooks';
import { SignInPanel } from '../identity/SignInPanel';
import { pollHref } from '../router';
import { useAsync } from '../useAsync';

function contestHref(target: string): string {
  return pollHref(encodePollKey(charterPollKey(target)));
}

/** The first thing on the page: where the election stands, in one sentence and a next step. */
function Summary({ sdk, network, status, now }: { sdk: EvoSDK; network: string; status: ElectionStatus; now: number }) {
  const { timing, team, contest } = status;
  const target = status.targetContractId;
  const contenders = contest?.tally.contenders ?? [];
  const phase = timing.phase;
  const tone = phaseTone(phase);

  let headline: ReactNode;
  let detail: ReactNode = null;
  if (team) {
    const score = winningScore(contenders, team.leaderId);
    headline = (
      <>
        <IdentityName sdk={sdk} id={team.leaderId} />
        &apos;s team holds this seat permanently.
      </>
    );
    detail = (
      <>
        {score && `Won ${score}`}
        {contest?.winner?.decidedAtMs && ` on ${dateText(contest.winner.decidedAtMs, { time: false })}`}
        {score && ' · '}
        {team.members.length === 0 ? 'No members besides the leader' : `${plural(team.members.length, 'member')} besides the leader`}
      </>
    );
  } else if (phase === 'decided') {
    headline = 'The vote is decided; the seated team could not be read yet.';
  } else if (phase === 'join-window' && timing.joinClosesAtMs) {
    headline = `Applications are open: ${plural(contenders.length, 'team')} applied so far.`;
    detail = `New teams can apply for ${countdown(timing.joinClosesAtMs, now).text} more (until ${dateText(timing.joinClosesAtMs)}).${
      contenders.length === 1 ? ' If nobody else applies, this team wins when the window closes.' : ''
    }`;
  } else if (phase === 'voting' || phase === 'closing') {
    headline =
      phase === 'voting'
        ? `Masternodes are voting between ${plural(contenders.length, 'team')}.`
        : 'Voting has closed; Platform is recording the result.';
    if (timing.endsAtMs && timing.endsAtMs > now) {
      detail = `Voting ends in ${countdown(timing.endsAtMs, now).text} (${dateText(timing.endsAtMs)}). New teams can no longer apply.`;
    }
  } else if (phase === 'notice') {
    headline =
      timing.opensAtMs === Number.POSITIVE_INFINITY
        ? 'This election never opens: the contract has no recorded creation time.'
        : `Applications open ${dateText(timing.opensAtMs ?? 0)}.`;
    detail = 'Teams can already file their proposals.';
  } else if (phase === 'proposals') {
    headline = `No team has applied yet. ${plural(status.proposals.length, 'proposal')} filed.`;
    detail = 'The first team to apply opens the race; others then have the join window to apply too.';
  } else if (phase === 'no-election') {
    headline = 'Nobody has proposed a team yet.';
    detail = 'Any Dash identity can propose one. The first team to apply opens the race.';
  } else if (phase === 'not-elected') {
    headline =
      status.contractFound === false
        ? `There is no contract with this id on ${network}.`
        : 'This contract does not hold moderator elections.';
  } else {
    headline = 'The election could not be read completely.';
    detail = 'Some reads failed (see above). Reload to try again.';
  }

  return (
    <section className={`status-panel tone-${tone}`} aria-label="Election status">
      <span className={`status-badge tone-${tone}`}>{PHASE_TEXT[phase]}</span>
      <p className="status-headline">{headline}</p>
      {detail && <p className="status-detail">{detail}</p>}
      <div className="status-actions">
        {contest && (
          <a className={contest.winner || team ? 'vote-button ghost' : 'vote-button'} href={contestHref(target)}>
            {contest.winner || team ? 'See the vote' : 'Vote with a masternode'}
          </a>
        )}
        {team && (
          <a className="vote-button ghost" href={proposalHref(target, team.submittedCharterId)}>
            Read their charter
          </a>
        )}
        {phase === 'not-elected' && (
          <>
            <a className="vote-button ghost" href="#/m">
              See all moderator elections
            </a>
            {status.contractFound !== false && (
              <a className="vote-button ghost" href={`#/c/${target}`}>
                Browse this contract&apos;s contests
              </a>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** The vote for the seat: each team's weighted votes and share. */
function Contest({ sdk, status }: { sdk: EvoSDK; status: ElectionStatus }) {
  const contest = status.contest;
  if (!contest) return null;
  const total = contest.tally.total;
  const decided = !!contest.winner || !!status.team;
  return (
    <section className="hub-section">
      <h2 className="section-title">{decided ? 'How masternodes voted' : 'The vote so far'}</h2>
      <ol className="hub-tally">
        {contest.tally.contenders.map((c) => {
          const share = total > 0 ? Math.round((c.votes / total) * 100) : 0;
          const won = contest.winner?.identityId === c.identityId;
          return (
            <li key={c.identityId} className={won ? 'won' : ''}>
              <span className="hub-tally-name">
                <IdentityName sdk={sdk} id={c.identityId} />
                {won && <span className="chip won">won</span>}
              </span>
              <span className="hub-tally-bar" aria-hidden="true">
                <span style={{ width: `${share}%` }} />
              </span>
              <span className="hub-tally-votes">{votesText(c.votes, total > 0 ? share : undefined)}</span>
            </li>
          );
        })}
      </ol>
      <p className="meta">
        {plural(total, 'vote')} in all
        {contest.tally.abstain > 0 && `, ${contest.tally.abstain} abstaining`}. Votes are weighted: a masternode
        counts 1, an evonode 4.
      </p>
    </section>
  );
}

function ProposalList({ sdk, status }: { sdk: EvoSDK; status: ElectionStatus }) {
  const target = status.targetContractId;
  const ranked = status.proposals
    .map((p) => ({ p, standing: proposalStanding(status, p) }))
    .sort((a, b) => rank(a.standing) - rank(b.standing) || (b.p.createdAtMs ?? 0) - (a.p.createdAtMs ?? 0));
  return (
    <ol className="proposal-list">
      {ranked.map(({ p, standing }) => {
        const chip = standingChip(standing);
        return (
          <li key={p.id}>
            <a className="proposal-item" href={proposalHref(target, p.id)}>
              <span className="proposal-item-head">
                <span className="proposal-item-title">{firstSentence(p.description)}</span>
                <span className={`chip tone-${chip.tone}`}>{chip.text}</span>
              </span>
              <span className="proposal-item-by">
                by <IdentityName sdk={sdk} id={p.leaderId} />
                {p.createdAtMs ? ` · filed ${dateText(p.createdAtMs, { time: false })}` : ''}
              </span>
              {afterFirstSentence(p.description) && (
                <span className="proposal-excerpt">{excerpt(afterFirstSentence(p.description), 180)}</span>
              )}
              <span className="meta">{proposalTerms(p)}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

function rank(s: Standing): number {
  switch (s.kind) {
    case 'seated':
      return 0;
    case 'applied':
      return 1 - s.votes / 1e6;
    case 'lost':
      return 2 - s.votes / 1e6;
    case 'not-applied':
      return 3;
    case 'closed':
      return 4;
    case 'unknown':
      return 5;
  }
}

/** "1 reason · team keeps 100% of fees · leader 40%, equal 30%, by actions 30%". */
export function proposalTerms(p: CharterProposal): string {
  const split = p.rewardSplit
    ? `leader ${p.rewardSplit.leader}%, shared ${p.rewardSplit.equal}%, by actions ${p.rewardSplit.actions}%`
    : 'payout split not readable';
  return `${plural(p.reasonIds.length, 'reason')} · takes ${p.moderatorsShare}% of fees · ${split}`;
}

/** `#/m/<target>`: one contract's moderator election. */
export function ElectionHubPage({ handle, target }: { handle: SdkHandle; target: string }) {
  const { sdk, network } = handle;
  const status = useAsync(() => fetchElectionStatus(sdk, target, { force: true }), [sdk, target]);
  const session = useIdentitySession();
  const now = useNow();
  const [proposing, setProposing] = useState(false);

  const s = status.status === 'ok' ? status.value : undefined;
  const elected = s?.moderation ? electedOf(s.moderation) : undefined;
  const header = (
    <header className="page-header">
      <a href="#/m" className="back-link">
        ← Moderator elections
      </a>
      <h1 className="page-title">Moderators of {targetName(target)}</h1>
      <p className="page-byline">
        <span>
          Contract <span className="mono" title={target}>{shortId(target)}</span>{' '}
          <CopyButton text={target} label="Copy contract id" />
        </span>
        {elected && <span>Moderates {moderatedTypesText(elected.moderatedDocumentTypes)}</span>}
      </p>
    </header>
  );

  if (!s) {
    return (
      <div className="contest-page hub-page">
        {header}
        {status.status === 'loading' ? (
          <p className="page-note" role="status">
            Reading the election from Platform…
          </p>
        ) : (
          <div className="page-note error" role="alert">
            <p>Could not read this election.</p>
            <TechnicalDetail>{status.status === 'error' ? status.message : ''}</TechnicalDetail>
            <button className="vote-button ghost" onClick={status.reload}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const open = OPEN_PHASES.has(s.timing.phase);
  const canPropose = !!elected && !s.team && s.timing.phase !== 'decided';
  return (
    <div className="contest-page hub-page">
      {header}
      <ReadIssues failures={s.failures} caps={s.proposalsCapped ? [{ source: 'proposals', limit: s.proposals.length }] : []} />
      <Summary sdk={sdk} network={network} status={s} now={now} />
      <Contest sdk={sdk} status={s} />

      {elected && (
        <section className="hub-section">
          <div className="section-head">
            <h2 className="section-title">Proposed teams · {s.proposals.length}</h2>
            {canPropose && !proposing && (
              <button
                className="vote-button"
                onClick={() => {
                  setProposing(true);
                  document.getElementById('propose')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                Propose a team
              </button>
            )}
          </div>
          {!canPropose && (
            <p className="callout">Proposals are closed: a team holds this seat permanently.</p>
          )}
          {s.proposals.length === 0 && (
            <p className="meta">
              {s.failures.some((f) => f.source === 'the filed proposals')
                ? 'The proposals could not be read.'
                : 'No team has filed a charter yet.'}
            </p>
          )}
          <ProposalList sdk={sdk} status={s} />
        </section>
      )}

      {canPropose && (
        <section className="hub-section propose" id="propose">
          <h2 className="section-title">Propose a team</h2>
          <p>
            Lead a moderation team for {targetName(target)}: write down what you would moderate and why, gather
            members, and apply for the seat. Here is the whole path and what it costs:
          </p>
          <ElectionSteps />
          {!proposing ? (
            <button className="vote-button" onClick={() => setProposing(true)}>
              Propose a team
            </button>
          ) : !session ? (
            <>
              <p>Sign in with your Dash identity to file reasons and a charter.</p>
              <SignInPanel network={network} />
            </>
          ) : (
            <CharterWizard handle={handle} session={session} targetContractId={target} onFiled={status.reload} />
          )}
        </section>
      )}

      {open && <CharterNotices />}

      {s.moderation && (
        <details className="rules">
          <summary>Contract rules</summary>
          <DeclarationCard moderation={s.moderation} />
        </details>
      )}
    </div>
  );
}
