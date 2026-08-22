import { useEffect, useRef, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import {
  fetchContests,
  fetchContestState,
  fetchUsernames,
  fetchVoters,
  type ContestState,
} from '../lib/dpns';
import { countdown, endDate, plural, shortId, type Countdown } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { Network } from '../lib/sdk';
import type { VoteChoice } from '../lib/vote';
import {
  ABSTAIN_COLOR,
  BallotBar,
  contenderColor,
  LOCK_COLOR,
} from './BallotBar';
import { ContestedName } from './ContestedName';

function useUsernames(sdk: EvoSDK, identityId: string): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchUsernames(sdk, identityId).then((result) => {
      if (!cancelled) setNames(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sdk, identityId]);
  return names;
}

function Voters({
  sdk,
  label,
  contenderId,
}: {
  sdk: EvoSDK;
  label: string;
  contenderId: string;
}) {
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
    fetchVoters(sdk, label, contenderId)
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
          ? '1 voter identity'
          : `${voters.length} voter identities${voters.length === 100 ? ' (first 100)' : ''}`}
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
  label,
  identityId,
  votes,
  requestedLabel,
  rank,
  share,
  isWinner,
  canVote,
  onVote,
}: {
  sdk: EvoSDK;
  label: string;
  identityId: string;
  votes: number;
  requestedLabel?: string;
  rank: number;
  share: number;
  isWinner: boolean;
  canVote: boolean;
  onVote: () => void;
}) {
  const names = useUsernames(sdk, identityId);
  return (
    <li className="contender">
      <span className="swatch" style={{ backgroundColor: contenderColor(rank) }} />
      <div className="contender-main">
        <div className="contender-id-line">
          {requestedLabel && (
            <span className="contender-requested">
              <ContestedName label={requestedLabel} />
            </span>
          )}
          <span className="mono contender-id" title={identityId}>
            {shortId(identityId, 8)}
          </span>
          {names.length > 0 && (
            <span className="contender-names">
              also holds {names.map((n) => `“${n}”`).join(', ')}
            </span>
          )}
          {isWinner && <span className="chip won">won</span>}
        </div>
        <Voters sdk={sdk} label={label} contenderId={identityId} />
      </div>
      <div className="contender-tally">
        <span className="tally-number">{votes}</span>
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

function statusChip(
  state: ContestState,
  timing: Countdown | undefined,
  endsAtMs: number | undefined,
) {
  if (state.winner) {
    const when = state.winner.decidedAtMs
      ? ` · ${endDate(state.winner.decidedAtMs)}`
      : '';
    if (state.winner.identityId) {
      return (
        <span className="chip won">
          awarded to {shortId(state.winner.identityId, 6)}
          {when}
        </span>
      );
    }
    if (state.winner.kind.toLowerCase().includes('lock')) {
      return <span className="chip locked">locked — awarded to no one{when}</span>;
    }
    return <span className="chip">decided — {state.winner.kind}{when}</span>;
  }
  if (timing && endsAtMs !== undefined) {
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

export function ContestPage({
  sdk,
  network,
  label,
  onVote,
}: {
  sdk: EvoSDK;
  network: Network;
  label: string;
  onVote: (choice: VoteChoice) => void;
}) {
  const [state, setState] = useState<ContestState | 'loading' | 'error'>('loading');
  const [endsAtMs, setEndsAtMs] = useState<number | undefined>();
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchContestState(sdk, label)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    // End time comes from the poll schedule; best effort. fetchContests
    // resolves with whatever loaded even on partial failure.
    void fetchContests(sdk).then((contests) => {
      if (cancelled) return;
      const match = contests.find((c) => c.label === label);
      if (match?.endsAtMs) setEndsAtMs(match.endsAtMs);
    });
    return () => {
      cancelled = true;
    };
  }, [sdk, label]);

  if (state === 'loading' || state === 'error') {
    return (
      <div className="contest-page">
        <ContestHeader label={label} />
        {state === 'loading' ? (
          <p className="page-note">Reading vote state from Platform…</p>
        ) : (
          <p className="page-note error">
            Could not load this contest. The name may not be under an active
            contest on {network}, or the network request failed.
          </p>
        )}
      </div>
    );
  }

  if (state.contenders.length === 0 && state.totalVotes === 0 && !state.winner) {
    return (
      <div className="contest-page">
        <ContestHeader label={label} />
        <p className="page-note">
          No active contest for this name on {network}.
        </p>
      </div>
    );
  }

  const timing = endsAtMs ? countdown(endsAtMs, now) : undefined;
  const votable = !state.winner;

  return (
    <div className="contest-page">
      <ContestHeader label={label} displayLabel={state.displayLabel} />

      <div className="contest-meta">
        {statusChip(state, timing, endsAtMs)}
        <span className="mono-label">{plural(state.totalVotes, 'vote')} cast</span>
      </div>

      <BallotBar state={state} />

      <ol className="contenders">
        {state.contenders.map((c, rank) => (
          <ContenderRow
            key={c.identityId}
            sdk={sdk}
            label={label}
            identityId={c.identityId}
            votes={c.votes}
            requestedLabel={c.requestedLabel}
            rank={rank}
            share={state.totalVotes > 0 ? c.votes / state.totalVotes : 0}
            isWinner={state.winner?.identityId === c.identityId}
            canVote={votable}
            onVote={() => onVote({ type: 'identity', identityId: c.identityId })}
          />
        ))}
      </ol>

      <div className="alt-choices">
        <div className="alt-choice">
          <span className="swatch" style={{ backgroundColor: ABSTAIN_COLOR }} />
          <span>Abstain</span>
          <span className="tally-number">{state.abstain}</span>
          {votable && (
            <button className="vote-button ghost" onClick={() => onVote({ type: 'abstain' })}>
              Vote abstain
            </button>
          )}
        </div>
        <div className="alt-choice">
          <span className="swatch hatched" style={{ backgroundColor: LOCK_COLOR }} />
          <span>Lock — award the name to no one</span>
          <span className="tally-number">{state.lock}</span>
          {votable && (
            <button className="vote-button ghost" onClick={() => onVote({ type: 'lock' })}>
              Vote lock
            </button>
          )}
        </div>
      </div>

      <p className="fine-print">
        Each masternode can cast up to 5 votes on a contest; the latest vote
        counts. Regular masternodes vote with weight 1, evonodes with weight 4.
        Campaigning happens off-chain — contenders usually post their identity
        on the{' '}
        <a href="https://forum.dash.org" target="_blank" rel="noreferrer">
          Dash forum
        </a>{' '}
        or Discord.
      </p>
    </div>
  );
}

function ContestHeader({
  label,
  displayLabel,
}: {
  label: string;
  displayLabel?: string;
}) {
  const shown = displayLabel || label;
  return (
    <header className="contest-header">
      <a href="#/" className="back-link">
        ← All contests
      </a>
      <h1 className="contest-title">
        <ContestedName label={shown} />
        <span className="tld">.dash</span>
      </h1>
      {shown.toLowerCase() !== label.toLowerCase() && (
        <p className="mono-label">registers as {label}.dash</p>
      )}
    </header>
  );
}
