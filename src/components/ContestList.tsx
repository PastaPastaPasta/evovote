import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import {
  fetchContests,
  fetchContestState,
  peekContestState,
  type ContestState,
  type ContestSummary,
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
  const [contests, setContests] = useState<ContestSummary[] | 'loading' | 'error'>('loading');
  const [states, setStates] = useState<Record<string, StateEntry>>({});
  const [filter, setFilter] = useState('');
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    setContests('loading');
    fetchContests(sdk)
      .then((shared) => {
        if (cancelled) return;
        // Copy before sorting: fetchContests memoizes and shares the array.
        const list = [...shared].sort(
          (a, b) => (a.endsAtMs ?? Infinity) - (b.endsAtMs ?? Infinity),
        );
        setContests(list);
        // Recently fetched tallies render immediately (back-navigation case);
        // only the rest go through the fetch pool.
        setStates(
          Object.fromEntries(
            list.map((c) => [c.label, peekContestState(c.label) ?? ('loading' as const)]),
          ),
        );

        // Tallies need one query per contest; fetch a few at a time so rows
        // fill in progressively instead of blocking on the whole set.
        const queue = list.filter((c) => !peekContestState(c.label));
        const workers = Array.from({ length: 4 }, async () => {
          for (;;) {
            const next = queue.shift();
            if (!next || cancelled) return;
            try {
              const state = await fetchContestState(sdk, next.label);
              if (!cancelled) {
                setStates((prev) => ({ ...prev, [next.label]: state }));
              }
            } catch {
              if (!cancelled) {
                setStates((prev) => ({ ...prev, [next.label]: 'error' }));
              }
            }
          }
        });
        void Promise.all(workers);
      })
      .catch(() => {
        if (!cancelled) setContests('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  const { open, ended } = useMemo(() => {
    if (!Array.isArray(contests)) return { open: [], ended: [] };
    const needle = filter.trim().toLowerCase();
    const matches = (c: ContestSummary) => {
      if (!needle) return true;
      if (c.label.toLowerCase().includes(needle)) return true;
      const state = states[c.label];
      return (
        typeof state === 'object' &&
        (state.displayLabel?.toLowerCase().includes(needle) ?? false)
      );
    };
    const open: ContestSummary[] = [];
    const ended: ContestSummary[] = [];
    for (const c of contests) {
      if (!matches(c)) continue;
      if (c.endsAtMs && c.endsAtMs > now) open.push(c);
      else ended.push(c);
    }
    // Open: closing soonest first. Ended: most recently closed first.
    open.sort((a, b) => a.endsAtMs! - b.endsAtMs!);
    ended.sort((a, b) => (b.endsAtMs ?? -Infinity) - (a.endsAtMs ?? -Infinity));
    return { open, ended };
  }, [contests, filter, states, now]);

  if (contests === 'loading') {
    return (
      <div className="sdk-loading">
        <div className="spinner" aria-hidden="true" />
        <p>Reading contested names from Platform…</p>
      </div>
    );
  }
  if (contests === 'error') {
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

  const soonest = open[0];

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
        <Legend />
      </div>

      {contests.length > 6 && (
        <input
          className="search"
          type="search"
          placeholder="Filter names"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter contested names"
        />
      )}

      {contests.length === 0 && (
        <p className="page-note">No usernames are currently contested.</p>
      )}

      {open.length > 0 && (
        <>
          <h2 className="section-title">Open for voting · {open.length}</h2>
          <ol className="ledger">{open.map((c) => row(c, true))}</ol>
        </>
      )}

      {ended.length > 0 && (
        <>
          <h2 className="section-title">Ended · {ended.length}</h2>
          <ol className="ledger">{ended.map((c) => row(c, false))}</ol>
        </>
      )}

      {open.length === 0 && ended.length === 0 && contests.length > 0 && (
        <p className="page-note">No contested names match “{filter.trim()}”.</p>
      )}
    </div>
  );
}
