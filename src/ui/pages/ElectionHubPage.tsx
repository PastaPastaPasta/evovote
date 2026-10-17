import type { EvoSDK } from '@dashevo/evo-sdk';
import { electedOf } from '../../charters/declaration';
import { splitText } from '../../charters/documents';
import { PHASE_TEXT } from '../../charters/phase';
import { charterPollKey, proposalHref } from '../../charters/pollKey';
import { fetchElectionStatus, type ElectionStatus } from '../../charters/reads';
import { useIdentitySession } from '../../identity/session';
import { targetName } from '../../kinds/charter';
import { encodePollKey } from '../../model/pollKey';
import type { SdkHandle } from '../../sdk/connection';
import { CharterNotices } from '../charters/CharterNotices';
import { CharterWizard } from '../charters/CharterWizard';
import { DeclarationCard } from '../charters/DeclarationCard';
import { IdentityName } from '../components/IdentityName';
import { ReadIssues } from '../components/ReadIssues';
import { countdown, endDate, plural, shortId } from '../format';
import { useNow } from '../hooks';
import { SignInPanel } from '../identity/SignInPanel';
import { pollHref } from '../router';
import { useAsync } from '../useAsync';

function Timing({ status, now }: { status: ElectionStatus; now: number }) {
  const t = status.timing;
  const parts: string[] = [];
  if (t.phase === 'notice' && t.opensAtMs && Number.isFinite(t.opensAtMs)) parts.push(`applications open ${endDate(t.opensAtMs)}`);
  if (t.joinClosesAtMs && t.joinClosesAtMs > now) parts.push(`join window closes in ${countdown(t.joinClosesAtMs, now).text}`);
  if (t.endsAtMs && t.endsAtMs > now) parts.push(`voting ends in ${countdown(t.endsAtMs, now).text} · ${endDate(t.endsAtMs)}`);
  return (
    <div className="contest-meta">
      <span className={t.phase === 'seated' || t.phase === 'decided' ? 'chip won' : 'chip'}>{PHASE_TEXT[t.phase]}</span>
      {parts.map((p) => (
        <span key={p} className="mono-label">
          {p}
        </span>
      ))}
    </div>
  );
}

function Team({ sdk, status }: { sdk: EvoSDK; status: ElectionStatus }) {
  const team = status.team;
  if (!team) return null;
  return (
    <section className="charter-card">
      <h2 className="section-title">Seated team</h2>
      <p>
        Leader <IdentityName sdk={sdk} id={team.leaderId} />
        {team.members.length > 0 ? ' with ' : ', no other members'}
        {team.members.map((m, i) => (
          <span key={m}>
            {i > 0 && ', '}
            <IdentityName sdk={sdk} id={m} />
          </span>
        ))}
        .
      </p>
      <p className="fine-print">
        The seat is permanent on protocol 14. Team changes (added or removed members, resignations) happen in
        the moderated app. <a href={proposalHref(status.targetContractId, team.submittedCharterId)}>The team&apos;s charter →</a>
      </p>
    </section>
  );
}

function Contest({ sdk, status }: { sdk: EvoSDK; status: ElectionStatus }) {
  const contest = status.contest;
  if (!contest) return null;
  const href = pollHref(encodePollKey(charterPollKey(status.targetContractId)));
  return (
    <section className="charter-card">
      <h2 className="section-title">The contest for the seat</h2>
      <ol className="contenders compact">
        {contest.tally.contenders.map((c) => (
          <li key={c.identityId} className="contender">
            <div className="contender-main">
              <IdentityName sdk={sdk} id={c.identityId} />
              {contest.winner?.identityId === c.identityId && <span className="chip won">won</span>}
            </div>
            <div className="contender-tally">
              <span className="tally-number">{c.votes}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="mono-label">
        {plural(contest.tally.total, 'vote')} cast, {contest.tally.abstain} abstain.
      </p>
      <p>
        <a className="vote-button" href={href}>
          {contest.winner ? 'See the result' : 'Masternodes: vote on this contest'}
        </a>
      </p>
      <CharterNotices />
    </section>
  );
}

/** `#/m/<target>`: one contract's moderator election. */
export function ElectionHubPage({ handle, target }: { handle: SdkHandle; target: string }) {
  const { sdk, network } = handle;
  const status = useAsync(() => fetchElectionStatus(sdk, target, { force: true }), [sdk, target]);
  const session = useIdentitySession();
  const now = useNow();

  const header = (
    <header className="contest-header">
      <a href="#/m" className="back-link">
        ← Moderated contracts
      </a>
      <h1 className="contest-title">
        <span className="kind-title">Moderators of {targetName(target)}</span>
      </h1>
      <p className="mono-label poll-meta">contract {target}</p>
    </header>
  );

  if (status.status !== 'ok') {
    return (
      <div className="contest-page">
        {header}
        {status.status === 'loading' ? (
          <p className="page-note">Reading the election from Platform…</p>
        ) : (
          <p className="page-note error">Could not read the election: {status.message}</p>
        )}
      </div>
    );
  }

  const s = status.value;
  const elected = s.moderation ? electedOf(s.moderation) : undefined;
  return (
    <div className="contest-page">
      {header}
      <Timing status={s} now={now} />
      <ReadIssues failures={s.failures} caps={s.proposalsCapped ? [{ source: 'proposals', limit: s.proposals.length }] : []} />
      {s.contractFound === false && <p className="page-note error">There is no contract with this id on {network}.</p>}
      {s.moderation && <DeclarationCard moderation={s.moderation} />}
      <Team sdk={sdk} status={s} />
      <Contest sdk={sdk} status={s} />

      {elected && (
        <section className="charter-card">
          <h2 className="section-title">Proposals · {s.proposals.length}</h2>
          {s.proposals.length === 0 && (
            <p className="mono-label">
              {s.failures.some((f) => f.source === 'the filed proposals') ? 'Could not be read.' : 'No team has filed a charter yet.'}
            </p>
          )}
          <ol className="ledger">
            {s.proposals.map((p) => (
              <li key={p.id}>
                <a className="ledger-row proposal-row" href={proposalHref(target, p.id)}>
                  <span className="ledger-name">
                    <IdentityName sdk={sdk} id={p.leaderId} />
                    {s.contest?.tally.contenders.some((c) => c.identityId === p.leaderId) && (
                      <span className="kind-chip">applied</span>
                    )}
                  </span>
                  <span className="proposal-excerpt">{p.description.slice(0, 140)}{p.description.length > 140 ? '…' : ''}</span>
                  <span className="mono-label">
                    share {p.moderatorsShare}% · {splitText(p.rewardSplit)} · {plural(p.reasonIds.length, 'reason')}
                  </span>
                  <span className="mono-label">{p.createdAtMs ? endDate(p.createdAtMs) : ''}</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}

      {elected && !s.team && (
        <section className="charter-card">
          <h2 className="section-title">Propose a moderation team</h2>
          {!session ? (
            <>
              <p>Sign in with your identity to file reasons and a charter for this contract.</p>
              <SignInPanel network={network} />
            </>
          ) : (
            <details>
              <summary>
                Lead a team as <strong>{session.names[0] ?? shortId(session.identityId, 6)}</strong>
              </summary>
              <CharterWizard handle={handle} session={session} targetContractId={target} onFiled={status.reload} />
            </details>
          )}
        </section>
      )}
    </div>
  );
}
