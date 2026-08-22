import { useEffect, useMemo, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import {
  fetchContests,
  fetchContestState,
  type ContestState,
  type ContestSummary,
} from '../lib/dpns';
import { countdown, plural, type Countdown } from '../lib/format';
import { useNow } from '../lib/hooks';
import { contestHref } from '../lib/router';
import type { Network } from '../lib/sdk';
import { BallotBar } from './BallotBar';
import { ContestedName } from './ContestedName';

type StateEntry = ContestState | 'loading' | 'error';

function rowStatus(state: StateEntry, timing?: Countdown): string {
  if (typeof state === 'object' && state.winner) return 'decided';
  if (!timing) return '';
  if (timing.past) return 'closing';
  return `closes in ${timing.text}`;
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
        setStates(Object.fromEntries(list.map((c) => [c.label, 'loading' as const])));

        // Tallies need one query per contest; fetch a few at a time so rows
        // fill in progressively instead of blocking on the whole set.
        const queue = [...list];
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

  const visible = useMemo(() => {
    if (!Array.isArray(contests)) return [];
    const needle = filter.trim().toLowerCase();
    return needle
      ? contests.filter((c) => c.label.toLowerCase().includes(needle))
      : contests;
  }, [contests, filter]);

  if (contests === 'loading') {
    return <p className="page-note">Reading contested names from Platform…</p>;
  }
  if (contests === 'error') {
    return (
      <p className="page-note error">
        Could not load contests. Check your connection and reload the page.
      </p>
    );
  }

  const soonest = contests.find((c) => c.endsAtMs && c.endsAtMs > now);

  return (
    <div className="contest-list">
      <div className="status-strip">
        <span className="mono-label">{plural(contests.length, 'active contest')}</span>
        {soonest?.endsAtMs && (
          <span className="mono-label">
            next closes in {countdown(soonest.endsAtMs, now).text}
          </span>
        )}
        <span className="mono-label">{network}</span>
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

      {contests.length === 0 ? (
        <p className="page-note">No usernames are currently contested.</p>
      ) : (
        <ol className="ledger">
          {visible.map((contest) => {
            const state = states[contest.label];
            const timing = contest.endsAtMs ? countdown(contest.endsAtMs, now) : undefined;
            return (
              <li key={contest.label}>
                <a className="ledger-row" href={contestHref(contest.label)}>
                  <span className="ledger-name">
                    <ContestedName label={contest.label} />
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
                  <span
                    className={
                      timing?.urgent ? 'ledger-ends mono-label urgent' : 'ledger-ends mono-label'
                    }
                  >
                    {rowStatus(state, timing)}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      )}
      {visible.length === 0 && contests.length > 0 && (
        <p className="page-note">No contested names match “{filter.trim()}”.</p>
      )}
    </div>
  );
}
