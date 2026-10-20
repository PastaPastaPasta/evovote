import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { getActivePolls } from '../../discovery/activePolls';
import type { Failure } from '../../discovery/types';
import { fetchContest } from '../../discovery/voteState';
import { charterTarget, moderatedHref } from '../../charters/pollKey';
import { dpnsDisplayLabel, dpnsLabel, fetchUsernames, normalizeDpnsLabel } from '../../kinds/dpns';
import { kindFor } from '../../kinds/registry';
import {
  isEmptyContest,
  isVotable,
  orderContenders,
  phaseOf,
  type Contest,
  type VoteChoice,
} from '../../model/contest';
import { displayIndexValue } from '../../model/indexValue';
import { decodePollKey, type PollKey } from '../../model/pollKey';
import { canVoteOnPoll } from '../../voting/cast';
import { VOTE_CHANGE_TEXT } from '../../voting/planner';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { CharterNotices } from '../charters/CharterNotices';
import { winningScore } from '../charters/standing';
import { useTargetName } from '../charters/useTargetName';
import { ABSTAIN_COLOR, BallotBar, contenderColor, LOCK_COLOR } from '../components/BallotBar';
import { KindTitle } from '../components/KindTitle';
import { PollIndexInfo } from '../components/PollIndexInfo';
import { ReadIssues } from '../components/ReadIssues';
import { CopyButton } from '../components/CopyButton';
import { ContenderCard, percent } from '../contest/ContenderCard';
import { Discussion, type ContenderInfo, type ContestOutcome } from '../discussion/Discussion';
import { countdown, endDate, plural, shortId } from '../format';
import { useNow } from '../hooks';

const EMPTY: ReadonlyMap<string, string[]> = new Map();
const EMPTY_TEAMS: ReadonlyMap<string, string> = new Map();

/** Every DPNS name of each identity (best effort), as they load. */
function useIdentityNames(sdk: EvoSDK, ids: readonly string[]): ReadonlyMap<string, string[]> {
  const [names, setNames] = useState<ReadonlyMap<string, string[]>>(EMPTY);
  const wanted = ids.join(',');
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    for (const id of wanted.split(',')) {
      void fetchUsernames(sdk, id).then((found) => {
        if (!cancelled && found.length > 0) setNames((prev) => new Map(prev).set(id, found));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [sdk, wanted]);
  return names;
}

/**
 * The one label a person gets on this page: their first DPNS name that is
 * not the contested name itself (the winner of a username holds it). Undefined
 * when there is none; the page then shows a short id.
 */
function personLabels(
  names: ReadonlyMap<string, string[]>,
  contested?: string,
): (id: string) => { label?: string; others: string[] } {
  const isContested = (n: string) => contested !== undefined && normalizeDpnsLabel(n.replace(/\.dash$/i, '')) === contested;
  return (id) => {
    const own = (names.get(id) ?? []).filter((n) => !isContested(n));
    return { label: own[0], others: own.slice(1) };
  };
}

/** Where the contest stands, as the hub says it: a tone badge and one plain sentence. */
export function contestStatus(
  contest: Pick<Contest, 'winner' | 'endsAtMs'>,
  now: number,
  winnerLabel?: string,
  /** The winner's tally against the rest, "12–4" or "unopposed" (see winningScore). */
  score?: string,
): { badge: string; tone: 'won' | 'live' | 'urgent' | 'muted'; text: string } {
  const { winner, endsAtMs } = contest;
  if (winner) {
    const when = winner.decidedAtMs ? ` on ${endDate(winner.decidedAtMs)}` : '';
    if (winner.kind === 'identity' && winner.identityId) {
      const by = score ? ` ${score}` : '';
      return { badge: 'Decided', tone: 'won', text: `${winnerLabel ?? shortId(winner.identityId)} won${by}${when}.` };
    }
    if (winner.kind === 'locked') return { badge: 'Locked', tone: 'muted', text: `Masternodes voted to award it to no one${when}.` };
    return { badge: 'Decided', tone: 'muted', text: `Platform recorded a result this site cannot read${when}.` };
  }
  if (endsAtMs !== undefined) {
    const timing = countdown(endsAtMs, now);
    if (timing.past) return { badge: 'Counting', tone: 'urgent', text: 'Voting has closed; Platform is recording the result.' };
    return {
      badge: timing.urgent ? 'Closing soon' : 'Voting open',
      tone: timing.urgent ? 'urgent' : 'live',
      text: `Voting closes in ${timing.text}, on ${endDate(endsAtMs)}.`,
    };
  }
  return { badge: 'Voting open', tone: 'live', text: 'Masternodes can vote now.' };
}

/** The contest's state, in the hub's status panel: badge, one sentence, the counts, the way to the discussion. */
function StatusPanel({ contest, now, winnerLabel, score, details, discussion }: {
  contest: Contest;
  now: number;
  winnerLabel?: string;
  score?: string;
  details: string[];
  discussion: ReactNode;
}) {
  const status = contestStatus(contest, now, winnerLabel, score);
  // The panel's edge takes the hub's tones; "urgent" is amber on the badge only.
  const edge = status.tone === 'urgent' ? 'live' : status.tone;
  return (
    <section className={`status-panel compact tone-${edge}`} aria-label="Contest status">
      <div className="status-row">
        <span className={`status-badge tone-${status.tone}`}>{status.badge}</span>
        {discussion}
      </div>
      <p className="status-headline">{status.text}</p>
      {details.length > 0 && (
        <p className="status-detail sep-list">
          {details.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </p>
      )}
    </section>
  );
}

function TechnicalDetails({ pollKey }: { pollKey: PollKey }) {
  return (
    <details className="contest-tech">
      <summary>Technical details</summary>
      <dl>
        <div>
          <dt>Contract</dt>
          <dd className="mono">{pollKey.contractId}</dd>
        </div>
        <div>
          <dt>Document type</dt>
          <dd className="mono">{pollKey.documentTypeName}</dd>
        </div>
        <div>
          <dt>Index</dt>
          <dd className="mono">{pollKey.indexName}</dd>
        </div>
        <div>
          <dt>Values</dt>
          <dd className="mono">{pollKey.indexValues.map(displayIndexValue).join(' / ')}</dd>
        </div>
      </dl>
    </details>
  );
}

/**
 * A moderator election's title: a question while it is open, a plain name
 * once decided (or while the contest is still being read).
 */
export function electionTitle(name: string, open: boolean): string {
  return open ? `Who should moderate ${name}?` : `Moderator election: ${name}`;
}

function ContestHeader({ sdk, pollKey, contest, now }: { sdk: EvoSDK; pollKey: PollKey; contest?: Contest; now: number }) {
  const label = dpnsLabel(pollKey);
  const target = charterTarget(pollKey);
  const name = useTargetName(target !== undefined ? sdk : undefined, target ?? '');
  const open = contest !== undefined && phaseOf(contest, now) !== 'decided';
  const summary = contest ?? { key: pollKey, keyString: '' };
  const kind = kindFor(pollKey);
  const shown = label !== undefined ? dpnsDisplayLabel(summary) : undefined;
  return (
    <header className="contest-header">
      {target !== undefined ? (
        <a href={moderatedHref(target)} className="back-link">
          ← Moderators of {name}
        </a>
      ) : (
        <a href="#/" className="back-link">
          ← All contests
        </a>
      )}
      {target !== undefined ? (
        <>
          {open && <p className="contest-eyebrow">Moderator election</p>}
          <h1 className="contest-title">{electionTitle(name, open)}</h1>
          <p className="contest-lede">
            Masternodes vote for the team that moderates contract{' '}
            <span className="mono" title={target}>
              {shortId(target)}
            </span>{' '}
            <CopyButton text={target} label="Copy contract id" />
          </p>
        </>
      ) : (
        <>
          <p className="contest-eyebrow">{kind.id === 'dpns' ? 'Username contest' : 'Contested document'}</p>
          <h1 className="contest-title">
            <KindTitle contest={summary} tld />
          </h1>
          {label !== undefined && shown && shown.toLowerCase() !== label.toLowerCase() && (
            <p className="contest-lede">Registers as {label}.dash</p>
          )}
        </>
      )}
      {kind.id === 'generic' && <PollIndexInfo sdk={sdk} pollKey={pollKey} />}
      {label === undefined && target === undefined && <TechnicalDetails pollKey={pollKey} />}
    </header>
  );
}

function JumpToDiscussion({ count }: { count?: string }) {
  return (
    <button
      type="button"
      className="jump-link"
      onClick={() => document.getElementById('discussion')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
    >
      {count === '0' ? 'Start the discussion' : `Jump to discussion${count !== undefined ? ` (${count})` : ''}`} ↓
    </button>
  );
}

export function ContestPage({
  handle,
  network,
  keyString,
  onVote,
}: {
  handle: SdkHandle;
  network: Network;
  keyString: string;
  onVote: (contest: Contest, choice: VoteChoice, names?: ReadonlyMap<string, string>) => void;
}) {
  const sdk = handle.sdk;
  const pollKey = decodePollKey(keyString);
  const [state, setState] = useState<Contest | 'loading' | { error: string }>('loading');
  const [endsAtMs, setEndsAtMs] = useState<number | undefined>();
  const [failures, setFailures] = useState<Failure[]>([]);
  const [commentCount, setCommentCount] = useState<string>();
  // Whether the open-poll walk has finished: a poll whose index values
  // `new VotePoll()` cannot rebuild is only votable once the walk found it.
  const [activeChecked, setActiveChecked] = useState(false);
  const now = useNow();
  // Memoized: contender rows key their effects on this object.
  const loaded = useMemo(
    () =>
      typeof state === 'object' && !('error' in state)
        ? { ...state, endsAtMs: endsAtMs ?? state.endsAtMs }
        : undefined,
    [state, endsAtMs],
  );

  const ordered = useMemo(
    () => (loaded ? orderContenders(loaded.tally.contenders, loaded.winner?.identityId) : []),
    [loaded],
  );
  const ids = useMemo(() => ordered.map((c) => c.identityId), [ordered]);
  const names = useIdentityNames(sdk, ids);
  const contested = pollKey ? dpnsLabel(pollKey) : undefined;
  const labels = useMemo(() => personLabels(names, contested), [names, contested]);
  const winnerId = loaded?.winner?.identityId;
  // A moderator election's contenders go by their team's name once their card has read the charter.
  const [teams, setTeams] = useState<ReadonlyMap<string, string>>(EMPTY_TEAMS);
  const onTeamName = useCallback(
    (id: string, team: string) => setTeams((prev) => (prev.get(id) === team ? prev : new Map(prev).set(id, team))),
    [],
  );

  // The contest's contenders as the discussion shows them: same label, same colour.
  const contenderInfo = useMemo<ContenderInfo[]>(
    () =>
      ordered.map((c, rank) => ({
        id: c.identityId,
        name: labels(c.identityId).label,
        color: contenderColor(rank),
        winner: c.identityId === winnerId,
      })),
    [ordered, labels, winnerId],
  );
  const outcome = useMemo<ContestOutcome | undefined>(() => {
    const winner = loaded?.winner;
    if (!winner) return undefined;
    return {
      decidedAtMs: winner.decidedAtMs,
      winnerName:
        winner.kind === 'identity' && winner.identityId
          ? (teams.get(winner.identityId) ?? labels(winner.identityId).label ?? shortId(winner.identityId))
          : undefined,
    };
  }, [loaded, labels, teams]);
  const onCount = useCallback((n: number, more: boolean) => setCommentCount(`${n}${more ? '+' : ''}`), [setCommentCount]);

  useEffect(() => {
    const key = decodePollKey(keyString);
    if (!key) return;
    // The page is keyed by keyString (App), so state starts fresh per contest.
    let cancelled = false;
    fetchContest(sdk, { key, keyString })
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ error: errorMessage(e) });
      });
    // The end time comes from the end-date index; its failures are shown,
    // never read as "not active".
    void getActivePolls(sdk).then((active) => {
      if (cancelled) return;
      const match = active.polls.find((p) => p.keyString === keyString);
      if (match?.endsAtMs) setEndsAtMs(match.endsAtMs);
      setFailures(active.failures);
      setActiveChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sdk, keyString]);

  if (!pollKey) {
    return (
      <div className="contest-page">
        <a href="#/" className="back-link">
          ← All contests
        </a>
        <p className="page-note error">This is not a valid contest link.</p>
      </div>
    );
  }

  const discussion = (
    <Discussion
      handle={handle}
      network={network}
      pollKey={pollKey}
      contenders={contenderInfo}
      outcome={outcome}
      onCount={onCount}
    />
  );

  if (!loaded) {
    return (
      <div className="contest-page">
        <ContestHeader sdk={sdk} pollKey={pollKey} now={now} />
        {typeof state === 'object' && 'error' in state ? (
          <div className="page-note error">
            <p>Could not load this contest on {network}. Reload to try again.</p>
            <details>
              <summary>Technical detail</summary>
              <p className="mono">{state.error}</p>
            </details>
          </div>
        ) : (
          <p className="page-note" role="status">
            Reading the votes from Platform…
          </p>
        )}
      </div>
    );
  }

  const contest = loaded;
  // The cards read more per contender: give them the state object, which does
  // not change when the end time arrives, so those reads run once.
  const described = state as Contest;
  const kind = kindFor(pollKey);

  if (isEmptyContest(contest)) {
    return (
      <div className="contest-page">
        <ContestHeader sdk={sdk} pollKey={pollKey} now={now} />
        <ReadIssues failures={failures} caps={[]} />
        <p className="page-note">Nobody contests this on {network}.</p>
        {discussion}
      </div>
    );
  }

  const choices = kind.choices(contest);
  const open = isVotable(contest, now);
  const phase = phaseOf(contest, now);
  const decided = phase === 'decided';
  const signable = canVoteOnPoll(pollKey, keyString);
  const votable = open && signable;
  const readIssues: Failure[] =
    contest.unreadableContenders > 0
      ? [
          ...failures,
          {
            source: 'the contenders',
            message: `${contest.unreadableContenders} contender(s) could not be read, so the tally is partial`,
          },
        ]
      : failures;
  const { total, abstain, lock } = contest.tally;
  const winner = ordered.find((c) => c.identityId === winnerId);
  const hasLock = choices.includes('lock');
  const tally = { ...contest.tally, contenders: ordered };
  const winnerLabel = winnerId ? (teams.get(winnerId) ?? labels(winnerId).label) : undefined;
  // Abstain and lock count in `total`; a score of contender votes only means something when some went to them.
  const score = winnerId && ordered.some((c) => c.votes > 0) ? winningScore(ordered, winnerId) : undefined;
  // The vote dialog names contenders as this page does.
  const voteNames = new Map<string, string>();
  for (const c of ordered) {
    const label = teams.get(c.identityId) ?? labels(c.identityId).label;
    if (label) voteNames.set(c.identityId, label);
  }

  return (
    <div className="contest-page">
      <ContestHeader sdk={sdk} pollKey={pollKey} contest={contest} now={now} />

      <StatusPanel
        contest={contest}
        now={now}
        winnerLabel={winnerLabel}
        score={score}
        details={[
          ...(ordered.length >= 2 ? [`${ordered.length} contenders`] : []),
          total === 0 ? (decided ? 'No votes were cast' : 'No votes yet') : `${plural(total, 'vote')} cast (weighted)`,
        ]}
        discussion={<JumpToDiscussion count={commentCount} />}
      />
      <ReadIssues failures={readIssues} caps={[]} />
      {open && !signable && (
        <p className="contest-quiet">
          {!activeChecked
            ? 'Checking that this poll is open for voting…'
            : failures.length > 0
              ? 'The list of open polls could not be read completely (see above), so this poll cannot be voted on from here. Reload to try again.'
              : 'This poll is not in the list of open polls read from Platform, so it cannot be voted on from here. Reload to try again.'}
        </p>
      )}
      {kind.id === 'charter' && !decided && <CharterNotices />}

      <section className="results" aria-labelledby="results-title">
        <div className="results-head">
          <h2 id="results-title">{decided ? 'Result' : 'Standings'}</h2>
          <p>Votes are weighted: a regular masternode counts 1, an evonode 4.</p>
        </div>
        {decided && winner && total === 0 && (
          <p className="contest-quiet">
            {ordered.length === 1
              ? 'Awarded without votes to the only applicant.'
              : hasLock
                ? 'Awarded without votes.'
                : 'Awarded without votes: the earliest applicant wins.'}
          </p>
        )}
        {decided && winner && total > 0 && winner.votes === 0 && (
          <p className="contest-quiet">
            {ordered.length === 1
              ? 'No votes went to a contender, so the only applicant won.'
              : hasLock
                ? 'No votes went to a contender; Platform still awarded it.'
                : 'No votes went to a contender, so the earliest applicant won.'}
          </p>
        )}
        {total > 0 && <BallotBar state={tally} showLock={hasLock} />}

        <ol className="contender-cards">
          {ordered.map((c, rank) => {
            const person = labels(c.identityId);
            return (
              <ContenderCard
                key={c.identityId}
                sdk={sdk}
                kind={kind}
                contest={described}
                contender={c}
                rank={rank}
                name={person.label}
                otherNames={person.others}
                headingLabel={kind.id === 'dpns' ? dpnsDisplayLabel(contest) : undefined}
                winnerVotes={winner && winner.identityId !== c.identityId ? winner.votes : undefined}
                canVote={votable && choices.includes('identity')}
                onVote={() => onVote(contest, { type: 'identity', identityId: c.identityId }, voteNames)}
                onTeamName={kind.id === 'charter' ? onTeamName : undefined}
              />
            );
          })}
        </ol>

        {!(decided && total === 0) && (
          <ul className="alt-rows">
            <li>
              <span className="swatch" style={{ backgroundColor: ABSTAIN_COLOR }} aria-hidden="true" />
              <span className="alt-label">Abstain</span>
              <span className="alt-tally">
                <strong>{abstain}</strong> {abstain === 1 ? 'vote' : 'votes'} · {percent(abstain, total)}
              </span>
              {votable && choices.includes('abstain') && (
                <button type="button" className="vote-button ghost" onClick={() => onVote(contest, { type: 'abstain' }, voteNames)}>
                  Vote abstain
                </button>
              )}
            </li>
            {hasLock && (
              <li>
                <span className="swatch hatched" style={{ backgroundColor: LOCK_COLOR }} aria-hidden="true" />
                <span className="alt-label">Lock: award it to no one</span>
                <span className="alt-tally">
                  <strong>{lock}</strong> {lock === 1 ? 'vote' : 'votes'} · {percent(lock, total)}
                </span>
                {votable && (
                  <button type="button" className="vote-button ghost" onClick={() => onVote(contest, { type: 'lock' }, voteNames)}>
                    Vote lock
                  </button>
                )}
              </li>
            )}
          </ul>
        )}

        {decided && total > 0 && (
          <p className="contest-quiet">Who voted is not kept after a contest is decided; Platform keeps only the totals.</p>
        )}
        <p className="contest-footnote">
          {VOTE_CHANGE_TEXT}
          {!hasLock && ' This contest has no Lock: there is always a winner, and a tie goes to the earliest applicant.'}
        </p>
      </section>

      {discussion}
    </div>
  );
}
