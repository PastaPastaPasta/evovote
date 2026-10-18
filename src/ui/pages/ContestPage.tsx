import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { getActivePolls } from '../../discovery/activePolls';
import type { Failure } from '../../discovery/types';
import { fetchContest, fetchVoters } from '../../discovery/voteState';
import { charterTarget, moderatedHref } from '../../charters/pollKey';
import { dpnsDisplayLabel, dpnsLabel } from '../../kinds/dpns';
import { kindFor } from '../../kinds/registry';
import type { ContenderView, ContestKind } from '../../kinds/types';
import {
  isEmptyContest,
  isVotable,
  type Contender,
  type Contest,
  type VoteChoice,
} from '../../model/contest';
import { displayIndexValue } from '../../model/indexValue';
import { decodePollKey, type PollKey } from '../../model/pollKey';
import { canVoteOnPoll } from '../../voting/cast';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { CharterNotices } from '../charters/CharterNotices';
import { ABSTAIN_COLOR, BallotBar, contenderColor, LOCK_COLOR } from '../components/BallotBar';
import { ContestedName } from '../components/ContestedName';
import { FieldTable } from '../components/FieldTable';
import { Discussion } from '../discussion/Discussion';
import { KindTitle } from '../components/KindTitle';
import { PollIndexInfo } from '../components/PollIndexInfo';
import { ReadIssues } from '../components/ReadIssues';
import { countdown, endDate, plural, shortId } from '../format';
import { useNow } from '../hooks';

function Voters({ sdk, pollKey, contenderId }: { sdk: EvoSDK; pollKey: PollKey; contenderId: string }) {
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
    fetchVoters(sdk, pollKey, contenderId)
      .then((result) => {
        if (mounted.current) setVoters(result);
      })
      .catch(() => {
        if (mounted.current) setVoters('error');
      });
  };

  if (voters === null) {
    return (
      <button className="link-button" onClick={load}>
        Show voters
      </button>
    );
  }
  if (voters === 'loading') return <p className="mono-label">Loading voters…</p>;
  if (voters === 'error') return <p className="mono-label error">Could not load voters.</p>;
  return (
    <div className="voters">
      <p className="mono-label">
        {voters.length === 1
          ? '1 masternode (ProTxHash)'
          : `${voters.length} masternodes (ProTxHash)${voters.length === 100 ? ', first 100' : ''}`}
      </p>
      <ul>
        {voters.map((v) => (
          <li key={v} className="mono">
            {v}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContenderRow({
  sdk,
  kind,
  contest,
  contender,
  rank,
  canVote,
  onVote,
}: {
  sdk: EvoSDK;
  kind: ContestKind;
  contest: Contest;
  contender: Contender;
  rank: number;
  canVote: boolean;
  onVote: () => void;
}) {
  const [view, setView] = useState<ContenderView>({ identityId: contender.identityId });
  useEffect(() => {
    let cancelled = false;
    kind
      .describeContender(sdk, contest, contender)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        // The id and tally still render; the extra context is optional.
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, kind, contest, contender]);

  const share = contest.tally.total > 0 ? contender.votes / contest.tally.total : 0;
  const isWinner = contest.winner?.identityId === contender.identityId;
  return (
    <li className="contender">
      <span className="swatch" style={{ backgroundColor: contenderColor(rank) }} />
      <div className="contender-main">
        <div className="contender-id-line">
          {view.title && (
            <span className="contender-requested">
              {kind.id === 'dpns' ? <ContestedName label={view.title} /> : view.title}
            </span>
          )}
          <span className="mono contender-id" title={contender.identityId}>
            {shortId(contender.identityId, 8)}
          </span>
          {view.subtitle && <span className="contender-names">{view.subtitle}</span>}
          {isWinner && <span className="chip won">won</span>}
        </div>
        {view.fields && view.fields.length > 0 && (
          <dl className="kv-table">
            {view.fields.map(([k, v]) => (
              <div key={k}>
                <dt className="mono-label">{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {view.rows && view.rows.length > 0 && <FieldTable rows={view.rows} />}
        {view.link && (
          <a className="link-button" href={view.link.href}>
            {view.link.label} →
          </a>
        )}
        <Voters sdk={sdk} pollKey={contest.key} contenderId={contender.identityId} />
      </div>
      <div className="contender-tally">
        <span className="tally-number">{contender.votes}</span>
        <span className="mono-label">{Math.round(share * 100)}%</span>
      </div>
      {canVote && (
        <button className="vote-button" onClick={onVote}>
          Vote for this
        </button>
      )}
    </li>
  );
}

function StatusChip({ contest, now }: { contest: Contest; now: number }) {
  const { winner, endsAtMs } = contest;
  if (winner) {
    const when = winner.decidedAtMs ? ` · ${endDate(winner.decidedAtMs)}` : '';
    if (winner.kind === 'identity' && winner.identityId) {
      return (
        <span className="chip won">
          awarded to {shortId(winner.identityId, 6)}
          {when}
        </span>
      );
    }
    if (winner.kind === 'locked') {
      return <span className="chip locked">locked — awarded to no one{when}</span>;
    }
    return (
      <span className="chip">
        decided — {winner.rawKind}
        {when}
      </span>
    );
  }
  if (endsAtMs !== undefined) {
    const timing = countdown(endsAtMs, now);
    return (
      <span className={timing.urgent ? 'chip urgent' : 'chip'}>
        {timing.past
          ? 'voting closed — awaiting finalization'
          : `closes in ${timing.text} · ${endDate(endsAtMs)}`}
      </span>
    );
  }
  return <span className="chip">active contest</span>;
}

function ContestHeader({
  sdk,
  pollKey,
  contest,
}: {
  sdk: EvoSDK;
  pollKey: PollKey;
  contest?: Contest;
}) {
  const label = dpnsLabel(pollKey);
  const target = charterTarget(pollKey);
  const summary = contest ?? { key: pollKey, keyString: '' };
  const shown = label !== undefined ? dpnsDisplayLabel(summary) : undefined;
  return (
    <header className="contest-header">
      <a href="#/" className="back-link">
        ← All contests
      </a>
      <h1 className="contest-title">
        <KindTitle contest={summary} tld />
      </h1>
      {label !== undefined && shown && shown.toLowerCase() !== label.toLowerCase() && (
        <p className="mono-label">registers as {label}.dash</p>
      )}
      {target !== undefined && (
        <p>
          <a href={moderatedHref(target)}>Election hub for this contract →</a>
        </p>
      )}
      {label === undefined && (
        <p className="mono-label poll-meta">
          contract {shortId(pollKey.contractId, 6)} · {pollKey.documentTypeName} ·{' '}
          {pollKey.indexName} · {pollKey.indexValues.map(displayIndexValue).join(' / ')}
        </p>
      )}
      {kindFor(pollKey).id === 'generic' && <PollIndexInfo sdk={sdk} pollKey={pollKey} />}
    </header>
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
  onVote: (contest: Contest, choice: VoteChoice) => void;
}) {
  const sdk = handle.sdk;
  const pollKey = decodePollKey(keyString);
  const [state, setState] = useState<Contest | 'loading' | { error: string }>('loading');
  const [endsAtMs, setEndsAtMs] = useState<number | undefined>();
  const [failures, setFailures] = useState<Failure[]>([]);
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

  // The identities in the contest: a charter's are its leaders.
  const contenderIds = useMemo(
    () => loaded?.tally.contenders.map((c) => c.identityId) ?? [],
    [loaded],
  );

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

  if (!loaded) {
    return (
      <div className="contest-page">
        <ContestHeader sdk={sdk} pollKey={pollKey} />
        {typeof state === 'object' && 'error' in state ? (
          <p className="page-note error">
            Could not load this contest on {network}: {state.error}
          </p>
        ) : (
          <p className="page-note">Reading vote state from Platform…</p>
        )}
      </div>
    );
  }

  const contest = loaded;
  const kind = kindFor(pollKey);

  if (isEmptyContest(contest)) {
    return (
      <div className="contest-page">
        <ContestHeader sdk={sdk} pollKey={pollKey} />
        <ReadIssues failures={failures} caps={[]} />
        <p className="page-note">Nobody contests this on {network}.</p>
        <Discussion handle={handle} network={network} pollKey={pollKey} contenders={contenderIds} />
      </div>
    );
  }

  const choices = kind.choices(contest);
  const open = isVotable(contest, now);
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
  const contenders = contest.tally.contenders;

  return (
    <div className="contest-page">
      <ContestHeader sdk={sdk} pollKey={pollKey} contest={contest} />

      <div className="contest-meta">
        <StatusChip contest={contest} now={now} />
        {contenders.length >= 2 && (
          <span className="contest-flag" title={`${contenders.length} contenders`}>
            {contenders.length} contenders
          </span>
        )}
        <span className="mono-label">{plural(contest.tally.total, 'vote')} cast</span>
      </div>
      <ReadIssues failures={readIssues} caps={[]} />
      {open && !signable && (
        <p className="mono-label">
          {!activeChecked
            ? 'Checking that this poll is open for voting…'
            : failures.length > 0
              ? 'The list of open polls could not be read completely (see above), so this poll cannot be voted on from here. Reload to try again.'
              : 'This poll is not in the list of open polls read from Platform, so it cannot be voted on from here. Reload to try again.'}
        </p>
      )}
      {kind.id === 'charter' && <CharterNotices />}

      <BallotBar state={contest.tally} showLock={choices.includes('lock')} />

      <ol className="contenders">
        {contenders.map((c, rank) => (
          <ContenderRow
            key={c.identityId}
            sdk={sdk}
            kind={kind}
            contest={contest}
            contender={c}
            rank={rank}
            canVote={votable && choices.includes('identity')}
            onVote={() => onVote(contest, { type: 'identity', identityId: c.identityId })}
          />
        ))}
      </ol>

      <div className="alt-choices">
        <div className="alt-choice">
          <span className="swatch" style={{ backgroundColor: ABSTAIN_COLOR }} />
          <span>Abstain</span>
          <span className="tally-number">{contest.tally.abstain}</span>
          {votable && choices.includes('abstain') && (
            <button className="vote-button ghost" onClick={() => onVote(contest, { type: 'abstain' })}>
              Vote abstain
            </button>
          )}
        </div>
        {choices.includes('lock') ? (
          <div className="alt-choice">
            <span className="swatch hatched" style={{ backgroundColor: LOCK_COLOR }} />
            <span>Lock — award it to no one</span>
            <span className="tally-number">{contest.tally.lock}</span>
            {votable && (
              <button className="vote-button ghost" onClick={() => onVote(contest, { type: 'lock' })}>
                Vote lock
              </button>
            )}
          </div>
        ) : (
          <p className="fine-print">
            This contest has no Lock: there is always a winner, and a tie goes to the
            earliest contender.
          </p>
        )}
      </div>

      <p className="fine-print">
        Each masternode can cast up to 5 votes on a contest, counting the first; the latest
        vote counts. Regular masternodes vote with weight 1, evonodes with weight 4.
      </p>

      <Discussion handle={handle} network={network} pollKey={pollKey} contenders={contenderIds} />
    </div>
  );
}
