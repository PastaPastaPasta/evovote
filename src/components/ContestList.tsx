import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import {
  fetchContestState,
  peekContestState,
  subscribeContests,
  type ContestState,
  type ContestSummary,
  type StreamStatus,
} from '../lib/dpns';
import { countdown, plural } from '../lib/format';
import { useNow } from '../lib/hooks';
import { contestHref } from '../lib/router';
import type { Network } from '../lib/sdk';
import {
  ABSTAIN_COLOR,
  BallotBar,
  contenderColor,
  LOCK_COLOR,
} from './BallotBar';
import { ContestedName } from './ContestedName';

type StateEntry = ContestState | 'loading' | 'error';

const TALLY_CONCURRENCY = 5;

interface Outcome {
  text: string;
  tone: 'won' | 'locked' | '';
}

/** The result of an ended contest, once its state has loaded. */
function outcome(state: StateEntry): Outcome | undefined {
  if (typeof state !== 'object' || !state.winner) return undefined;
  if (state.winner.identityId) return { text: 'awarded', tone: 'won' };
  if (state.winner.kind.toLowerCase().includes('lock')) {
    return { text: 'locked', tone: 'locked' };
  }
  return { text: 'no winner', tone: '' };
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i style={{ backgroundColor: contenderColor(0) }} /> leader
      </span>
      <span>
        <i style={{ backgroundColor: contenderColor(1) }} /> other contenders
      </span>
      <span>
        <i style={{ backgroundColor: ABSTAIN_COLOR }} /> abstain
      </span>
      <span>
        <i className="hatched" style={{ backgroundColor: LOCK_COLOR }} /> lock
      </span>
    </div>
  );
}

export function ContestList({ sdk, network }: { sdk: EvoSDK; network: Network }) {
  // Batches arrive already in display order: open soonest-closing first,
  // then ended newest first, then the archive.
  const [open, setOpen] = useState<ContestSummary[]>([]);
  const [ended, setEnded] = useState<ContestSummary[]>([]);
  const [states, setStates] = useState<Record<string, StateEntry>>({});
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('streaming');
  const [filter, setFilter] = useState('');
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    setOpen([]);
    setEnded([]);
    setStates({});
    setStreamStatus('streaming');

    // Tallies stream too: rows enqueue as their batch lands, in the same
    // most-relevant-first order, a few in flight at a time.
    const queue: string[] = [];
    let workers = 0;
    const pump = () => {
      while (workers < TALLY_CONCURRENCY && queue.length > 0 && !cancelled) {
        const label = queue.shift()!;
        workers++;
        fetchContestState(sdk, label)
          .then((state) => {
            if (!cancelled) setStates((prev) => ({ ...prev, [label]: state }));
          })
          .catch(() => {
            if (!cancelled) setStates((prev) => ({ ...prev, [label]: 'error' }));
          })
          .finally(() => {
            workers--;
            if (!cancelled) pump();
          });
      }
    };

    const unsubscribe = subscribeContests(
      sdk,
      (batch) => {
        if (cancelled) return;
        const append = (prev: ContestSummary[]) => [...prev, ...batch.list];
        if (batch.phase === 'open') setOpen(append);
        else setEnded(append);
        const seeded: Record<string, StateEntry> = {};
        for (const contest of batch.list) {
          const cached = peekContestState(contest.label);
          seeded[contest.label] = cached ?? 'loading';
          if (!cached) queue.push(contest.label);
        }
        setStates((prev) => ({ ...prev, ...seeded }));
        pump();
      },
      (status) => {
        if (!cancelled) setStreamStatus(status);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sdk]);

  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return () => true;
    return (contest: ContestSummary) => {
      if (contest.label.toLowerCase().includes(needle)) return true;
      const state = states[contest.label];
      return (
        typeof state === 'object' &&
        (state.displayLabel?.toLowerCase().includes(needle) ?? false)
      );
    };
  }, [needle, states]);

  const visibleOpen = open.filter(matches);
  // Ended contests: most recently decided first, once their tallies (which
  // carry the deciding block time) have arrived; unknowns keep stream order.
  const visibleEnded = useMemo(() => {
    const decidedAt = (c: ContestSummary) => {
      const state = states[c.label];
      return typeof state === 'object' ? (state.winner?.decidedAtMs ?? 0) : 0;
    };
    return ended
      .filter(matches)
      .map((c, index) => ({ c, index, at: decidedAt(c) }))
      .sort((a, b) => b.at - a.at || a.index - b.index)
      .map((entry) => entry.c);
  }, [ended, matches, states]);
  const total = open.length + ended.length;
  const streaming = streamStatus === 'streaming';

  if (total === 0) {
    if (streaming) {
      return (
        <div className="sdk-loading">
          <div className="spinner" aria-hidden="true" />
          <p>Reading contested names from Platform…</p>
        </div>
      );
    }
    if (streamStatus === 'error') {
      return (
        <div className="sdk-loading">
          <p className="error">
            Could not load contests. Check your connection and reload the page.
          </p>
          <button className="vote-button" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      );
    }
    return <p className="page-note">No usernames are currently contested.</p>;
  }

  const soonest = open.find((c) => c.endsAtMs && c.endsAtMs > now);

  const row = (contest: ContestSummary, isOpen: boolean) => {
    const state = states[contest.label];
    const timing = contest.endsAtMs ? countdown(contest.endsAtMs, now) : undefined;
    const result = outcome(state);
    let status: ReactNode;
    let statusClass = 'ledger-ends mono-label';
    if (isOpen) {
      status = timing ? `closes in ${timing.text}` : '';
      if (timing?.urgent) statusClass += ' urgent';
    } else if (result) {
      status = result.text;
      if (result.tone) statusClass += ` ${result.tone}`;
    } else if (state === 'loading') {
      status = '…';
    } else {
      status = 'awaiting result';
    }
    return (
      <li key={contest.label}>
        <a
          className={isOpen ? 'ledger-row' : 'ledger-row ended'}
          href={contestHref(contest.label)}
        >
          <span className="ledger-name">
            <ContestedName
              label={
                (typeof state === 'object' && state.displayLabel) || contest.label
              }
            />
          </span>
          <span className="ledger-bar">
            {state === 'loading' && <span className="bar-skeleton" />}
            {state === 'error' && (
              <span className="mono-label error">tally unavailable</span>
            )}
            {typeof state === 'object' && <BallotBar state={state} mini />}
          </span>
          <span className="ledger-votes mono-label">
            {typeof state === 'object' ? plural(state.totalVotes, 'vote') : ''}
          </span>
          <span className={statusClass}>{status}</span>
        </a>
      </li>
    );
  };

  return (
    <div className="contest-list">
      <div className="status-strip">
        <span className="mono-label">{plural(open.length, 'open contest')}</span>
        {soonest?.endsAtMs && (
          <span className="mono-label">
            next closes in {countdown(soonest.endsAtMs, now).text}
          </span>
        )}
        <span className="mono-label">{network}</span>
        {streaming && <span className="mono-label">loading more…</span>}
        <Legend />
      </div>

      {total > 6 && (
        <input
          className="search"
          type="search"
          placeholder="Filter names"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter contested names"
        />
      )}

      {visibleOpen.length > 0 && (
        <>
          <h2 className="section-title">Open for voting · {visibleOpen.length}</h2>
          <ol className="ledger">{visibleOpen.map((c) => row(c, true))}</ol>
        </>
      )}

      {visibleEnded.length > 0 && (
        <>
          <h2 className="section-title">Ended · {visibleEnded.length}</h2>
          <ol className="ledger">{visibleEnded.map((c) => row(c, false))}</ol>
        </>
      )}

      {visibleOpen.length === 0 && visibleEnded.length === 0 && (
        <p className="page-note">No contested names match “{filter.trim()}”.</p>
      )}
    </div>
  );
}
