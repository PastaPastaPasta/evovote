import { useEffect, useRef, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { fetchVoters } from '../../discovery/voteState';
import { displayText } from '../../discussion/text';
import type { CharterApplicationView, ContenderView, ContestKind } from '../../kinds/types';
import type { Contender, Contest } from '../../model/contest';
import type { PollKey } from '../../model/pollKey';
import { contenderColor } from '../components/BallotBar';
import { ContestedName } from '../components/ContestedName';
import { CopyButton } from '../components/CopyButton';
import { FieldTable } from '../components/FieldTable';
import { afterFirstSentence, dateText, shortId } from '../format';
import { teamName } from '../charters/standing';

/** Percent of all weight cast, as the page shows it everywhere. */
export const percent = (part: number, total: number): string =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';

/**
 * The voter list's line. A contender's votes are weighted (an evonode counts
 * 4), so the node count and the votes differ; say both, in that order.
 */
export function votersText(nodes: number, votes: number): string {
  const who = nodes === 1 ? '1 masternode' : `${nodes >= 100 ? 'At least ' : ''}${nodes} masternodes`;
  const worth = votes === 1 ? '1 vote' : `${votes} votes`;
  // A capped list or a stale read says nothing about evonodes.
  if (nodes >= 100) return `${who} voted for this (${worth} in all).`;
  return votes > nodes ? `${who} voted for this, worth ${worth}: an evonode's vote counts 4.` : `${who} voted for this.`;
}

/** Prose longer than this is cut at a word with "Read full charter". */
const CHARTER_EXCERPT = 280;

function excerpt(text: string): { text: string; cut: boolean } {
  if (text.length <= CHARTER_EXCERPT) return { text, cut: false };
  const head = text.slice(0, CHARTER_EXCERPT);
  const space = head.lastIndexOf(' ');
  return { text: `${(space > CHARTER_EXCERPT * 0.6 ? head.slice(0, space) : head).trimEnd()}…`, cut: true };
}

/**
 * Who voted for a contender, on request. Only an undecided contest has the
 * list: Platform keeps just the totals once it is decided (the page says so
 * once, instead of offering this).
 */
function Voters({ sdk, pollKey, contender }: { sdk: EvoSDK; pollKey: PollKey; contender: Contender }) {
  const [voters, setVoters] = useState<string[] | 'loading' | 'error' | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = () => {
    setVoters('loading');
    fetchVoters(sdk, pollKey, contender.identityId)
      .then((result) => mounted.current && setVoters(result))
      .catch(() => mounted.current && setVoters('error'));
  };

  if (voters === null) {
    return (
      <button type="button" className="text-action" onClick={load}>
        Show voters
      </button>
    );
  }
  if (voters === 'loading') return <span className="contender-quiet">Loading voters…</span>;
  if (voters === 'error') {
    return (
      <span className="contender-quiet">
        Could not load the voters.{' '}
        <button type="button" className="text-action" onClick={load}>
          Try again
        </button>
      </span>
    );
  }
  if (voters.length === 0) {
    return (
      <span className="contender-quiet">
        Voter list unavailable from this node.{' '}
        <button type="button" className="text-action" onClick={load}>
          Try again
        </button>
      </span>
    );
  }
  return (
    <div className="voters-panel">
      <p>{votersText(voters.length, contender.votes)}</p>
      <ul>
        {voters.map((v) => (
          <li key={v}>
            <span className="mono" title={`Masternode ${v}`}>
              {shortId(v)}
            </span>{' '}
            <CopyButton text={v} label={`Copy masternode id ${shortId(v)}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A contender's charter: its prose (after the title sentence, when the card
 * is headed by it), terms and team. `decidedLoser`: the contest went to
 * someone else, so the application and its member list are gone.
 */
export function CharterBlock({ charter, titled, decidedLoser }: { charter: CharterApplicationView; titled: boolean; decidedLoser: boolean }) {
  const body = titled ? afterFirstSentence(charter.description) : charter.description;
  const prose = excerpt(displayText(body));
  const split = charter.rewardSplit;
  return (
    <div className="charter-block">
      {prose.text ? (
        <blockquote className="charter-quote">
          <p>{prose.text}</p>
          {prose.cut && <a href={charter.href}>Read full charter →</a>}
        </blockquote>
      ) : titled ? null : (
        <p className="contender-quiet">The charter has no description.</p>
      )}
      <ul className="charter-chips" aria-label="Charter terms">
        <li>
          <span>Fee share</span> {charter.moderatorsShare}%
        </li>
        {split && (
          <li>
            <span>Split</span> leader {split.leader} · equal {split.equal} · by actions {split.actions}
          </li>
        )}
        {charter.reasons === undefined ? (
          <li>
            <span>Reasons</span> could not be read
          </li>
        ) : charter.reasons.length === 0 && charter.missingReasons === 0 ? (
          <li>
            <span>Reasons</span> none
          </li>
        ) : (
          charter.reasons.map((r, i) => (
            <li key={i} title={r.label}>
              <span>{r.code}</span> {r.label}
            </li>
          ))
        )}
        {charter.missingReasons > 0 && (
          <li>
            <span>Reasons</span> {charter.missingReasons} listed no longer exist
          </li>
        )}
      </ul>
      {charter.guessedFrom !== undefined && (
        <p className="contender-quiet">
          The application is gone, so this is the latest of {charter.guessedFrom} proposals this applicant filed for
          this contract before the decision.
        </p>
      )}
      {charter.members ? (
        <p className="contender-quiet">
          Team: {charter.members.length > 0 ? charter.members.join(', ') : 'the leader alone'}
          {charter.appliedAtMs ? ` · applied ${dateText(charter.appliedAtMs, { time: false })}` : ''}
        </p>
      ) : (
        decidedLoser && <p className="contender-quiet">Team: not shown. Platform drops a losing application&apos;s member list once the vote is decided.</p>
      )}
    </div>
  );
}

/**
 * One contender: who, the weight behind them, and (for a moderator
 * election) the charter they stand on. `name` is the page's single label
 * for this identity; the full id is in the tooltip and behind the copy icon.
 * A moderator-election card is headed by its team's name (the charter's
 * title), with the leader under it; `onTeamName` passes that name up so the
 * rest of the page uses it too.
 */
export function ContenderCard({
  sdk,
  kind,
  contest,
  contender,
  rank,
  name,
  otherNames,
  headingLabel,
  winnerVotes,
  canVote,
  onVote,
  onTeamName,
}: {
  sdk: EvoSDK;
  kind: ContestKind;
  contest: Contest;
  contender: Contender;
  rank: number;
  name?: string;
  /** Other DPNS names this identity holds. */
  otherNames: string[];
  /** The contest's own name (DPNS), to tell a different spelling apart. */
  headingLabel?: string;
  /** The winner's weight, when another contender won. */
  winnerVotes?: number;
  canVote: boolean;
  onVote: () => void;
  onTeamName?: (identityId: string, team: string) => void;
}) {
  const [view, setView] = useState<ContenderView | 'failed'>({ identityId: contender.identityId });
  useEffect(() => {
    let cancelled = false;
    kind.describeContender(sdk, contest, contender).then(
      (v) => !cancelled && setView(v),
      // A failed re-read keeps what an earlier read showed.
      () => !cancelled && setView((prev) => (prev !== 'failed' && (prev.charter !== undefined || prev.rows) ? prev : 'failed')),
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, kind, contest, contender]);

  const described = view === 'failed' ? undefined : view;
  const isWinner = contest.winner?.identityId === contender.identityId;
  const decided = contest.winner !== undefined;
  const total = contest.tally.total;
  const charter = described?.charter;
  // The name this applicant asked for, when it differs from the contest's own spelling.
  const requested = kind.id === 'dpns' ? described?.title : undefined;
  const askedFor = requested && requested !== headingLabel ? requested : undefined;
  // A contest decided without votes says so once above the cards; "Lost 0–0"
  // and a row of zeros would only repeat it.
  const unvoted = decided && total === 0;
  const lost = decided && !unvoted && !isWinner && winnerVotes !== undefined;
  const voters = !decided && contender.votes > 0;
  const team = kind.id === 'charter' && charter ? teamName(charter.description) : undefined;
  useEffect(() => {
    if (team) onTeamName?.(contender.identityId, team);
  }, [team, contender.identityId, onTeamName]);
  const person = name ?? <span className="mono">{shortId(contender.identityId)}</span>;

  return (
    <li className={isWinner ? 'contender-card winner' : 'contender-card'}>
      <span className="swatch" style={{ backgroundColor: contenderColor(rank) }} aria-hidden="true" />
      <div className="contender-body">
        <div className="contender-head">
          {team ? (
            <span className="contender-name">{team}</span>
          ) : (
            <span className="contender-name" title={contender.identityId}>
              {person}
            </span>
          )}
          {!team && <CopyButton text={contender.identityId} label={`Copy identity id of ${name ?? shortId(contender.identityId)}`} />}
          {isWinner && <span className="badge winner">Winner</span>}
        </div>
        {askedFor || otherNames.length > 0 || lost || team ? (
          <p className="contender-sub">
            {team && (
              <span title={contender.identityId}>
                led by {person} <CopyButton text={contender.identityId} label={`Copy identity id of ${name ?? shortId(contender.identityId)}`} />
              </span>
            )}
            {askedFor && (
              <span>
                asked for <ContestedName label={askedFor} />
              </span>
            )}
            {otherNames.length > 0 && <span>also holds {otherNames.join(', ')}</span>}
            {lost && (
              <span>
                {contender.votes === winnerVotes
                  ? `Tied ${contender.votes}–${winnerVotes}${kind.id === 'charter' ? ' · the earliest applicant wins ties' : ''}`
                  : `Lost ${contender.votes}–${winnerVotes}`}
              </span>
            )}
          </p>
        ) : null}
        {kind.id === 'charter' && charter === null && (
          <p className="contender-quiet">{described?.subtitle ?? 'No charter found for this applicant.'}</p>
        )}
        {kind.id === 'charter' && view === 'failed' && (
          <p className="contender-quiet">This applicant's charter could not be read. Reload to try again.</p>
        )}
        {charter && <CharterBlock charter={charter} titled={!!team} decidedLoser={decided && !isWinner} />}
        {described?.subtitle && kind.id === 'generic' && <p className="contender-sub">{described.subtitle}</p>}
        {described?.rows && described.rows.length > 0 && <FieldTable rows={described.rows} />}
        {(charter || described?.link || voters) && (
          <div className="contender-links">
            {charter && <a href={charter.href}>Open the proposal →</a>}
            {described?.link && !charter && <a href={described.link.href}>{described.link.label} →</a>}
            {voters && <Voters sdk={sdk} pollKey={contest.key} contender={contender} />}
          </div>
        )}
      </div>
      <div className="contender-side">
        {!unvoted && (
          <div className="contender-tally">
            <span className="tally-number">{contender.votes}</span>
            <span className="tally-unit">
              {contender.votes === 1 ? 'vote' : 'votes'} · {percent(contender.votes, total)}
            </span>
          </div>
        )}
        {canVote && (
          <button type="button" className="vote-button" onClick={onVote}>
            Vote for this
          </button>
        )}
      </div>
    </li>
  );
}
