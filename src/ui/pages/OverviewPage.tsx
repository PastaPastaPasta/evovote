import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { createPump } from '../../discovery/concurrency';
import { subscribeContests, type StreamReport } from '../../discovery/stream';
import { fetchContest, peekContest } from '../../discovery/voteState';
import { ARCHIVE_SOURCES, KINDS, kindById, kindFor } from '../../kinds/registry';
import type { KindId } from '../../kinds/types';
import type { Contest, ContestSummary } from '../../model/contest';
import type { Network } from '../../sdk/network';
import { ABSTAIN_COLOR, BallotBar, contenderColor, LOCK_COLOR } from '../components/BallotBar';
import { KindTitle } from '../components/KindTitle';
import { ReadIssues } from '../components/ReadIssues';
import { countdown, plural } from '../format';
import { useNow } from '../hooks';
import { kindHref, pollHref } from '../router';

type StateEntry = Contest | 'loading' | 'error';

/** Vote-state reads in flight at once while the list streams. */
const TALLY_CONCURRENCY = 5;

interface Outcome {
  text: string;
  tone: 'won' | 'locked' | '';
}

/** The result of an ended contest, once its state has loaded. */
function outcome(state: StateEntry | undefined): Outcome | undefined {
  if (typeof state !== 'object' || !state.winner) return undefined;
  if (state.winner.kind === 'identity') return { text: 'awarded', tone: 'won' };
  if (state.winner.kind === 'locked') return { text: 'locked', tone: 'locked' };
  return { text: 'no winner', tone: '' };
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i style={{ backgroundColor: contenderColor(0) }} /> leader
      </span>
      <span>
        <i style={{ backgroundColor: contenderColor(1) }} /> challenger
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

function KindTabs({
  active,
  counts,
}: {
  active?: KindId;
  counts: Record<KindId, number>;
}) {
  return (
    <nav className="kind-tabs" aria-label="Contest kinds">
      <a href="#/" className={active ? '' : 'current'} aria-current={active ? undefined : 'page'}>
        All
      </a>
      {KINDS.map((k) => (
        <a
          key={k.id}
          href={kindHref(k.id)}
          className={active === k.id ? 'current' : ''}
          aria-current={active === k.id ? 'page' : undefined}
        >
          {k.label} <span className="mono-label">{counts[k.id]}</span>
        </a>
      ))}
    </nav>
  );
}

/**
 * The ledger of every contest Platform knows about (`#/`), or of one kind
 * (`#/k/<kind>`). Rows stream in most-relevant-first: open soonest-closing,
 * then ended newest-first, then each kind's archive of decided contests.
 */
export function OverviewPage({
  sdk,
  network,
  kindFilter,
}: {
  sdk: EvoSDK;
  network: Network;
  kindFilter?: KindId;
}) {
  const [active, setActive] = useState<ContestSummary[]>([]);
  const [archive, setArchive] = useState<ContestSummary[]>([]);
  const [states, setStates] = useState<Record<string, StateEntry>>({});
  const [report, setReport] = useState<StreamReport>({
    status: 'streaming',
    failures: [],
    caps: [],
  });
  const [filter, setFilter] = useState('');
  const now = useNow();

  useEffect(() => {
    // One SDK connection per page load, so this runs once per mount.
    let cancelled = false;

    // Tallies stream too: rows enqueue as their batch lands, in display
    // order, a few in flight at a time.
    const pump = createPump<ContestSummary>(TALLY_CONCURRENCY, (summary) =>
      fetchContest(sdk, summary).then(
        (state) => {
          if (!cancelled) setStates((prev) => ({ ...prev, [summary.keyString]: state }));
        },
        () => {
          if (!cancelled) setStates((prev) => ({ ...prev, [summary.keyString]: 'error' }));
        },
      ),
    );

    const unsubscribe = subscribeContests(
      sdk,
      ARCHIVE_SOURCES,
      (batch) => {
        if (cancelled) return;
        // Dedupe: a reused run replays its batches, and StrictMode mounts twice in dev.
        const append = (prev: ContestSummary[]) => {
          const have = new Set(prev.map((c) => c.keyString));
          return [...prev, ...batch.list.filter((c) => !have.has(c.keyString))];
        };
        if (batch.phase === 'active') setActive(append);
        else setArchive(append);
        const seeded: Record<string, StateEntry> = {};
        const toFetch: ContestSummary[] = [];
        for (const contest of batch.list) {
          const cached = peekContest(contest.keyString);
          seeded[contest.keyString] = cached ?? 'loading';
          if (!cached) toFetch.push(contest);
        }
        setStates((prev) => ({ ...prev, ...seeded }));
        pump.push(toFetch);
      },
      (next) => {
        if (!cancelled) setReport(next);
      },
    );

    return () => {
      cancelled = true;
      pump.cancel();
      unsubscribe();
    };
  }, [sdk]);

  const counts = useMemo(() => {
    const out = { dpns: 0, charter: 0, generic: 0 } as Record<KindId, number>;
    for (const c of [...active, ...archive]) out[kindFor(c.key).id]++;
    return out;
  }, [active, archive]);

  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    return (contest: ContestSummary) => {
      const kind = kindFor(contest.key);
      if (kindFilter && kind.id !== kindFilter) return false;
      if (!needle) return true;
      const state = states[contest.keyString];
      const shown = typeof state === 'object' ? state : contest;
      return (
        kind.title(shown).toLowerCase().includes(needle) ||
        kind.title(contest).toLowerCase().includes(needle)
      );
    };
  }, [needle, states, kindFilter]);

  // Classification is live: a contest whose end passes while the page is
  // open moves to the ended section.
  const stillOpen = active.filter((c) => c.endsAtMs !== undefined && c.endsAtMs > now);
  const expired = active
    .filter((c) => c.endsAtMs === undefined || c.endsAtMs <= now)
    .reverse();

  const visibleOpen = stillOpen.filter(matches);
  // Ended rows only ever append at the bottom, never reshuffle as tallies load.
  const visibleEnded = [...expired, ...archive].filter(matches);
  const total = active.length + archive.length;
  const streaming = report.status === 'streaming';
  const heading = kindFilter ? kindById(kindFilter)?.label : undefined;

  if (total === 0) {
    if (streaming) {
      return (
        <div className="sdk-loading">
          <div className="spinner" aria-hidden="true" />
          <p>Reading contested resources from Platform…</p>
        </div>
      );
    }
    if (report.status === 'error') {
      return (
        <div className="sdk-loading">
          <p className="error">
            Could not load contests. Check your connection and reload the page.
          </p>
          <ReadIssues failures={report.failures} caps={report.caps} />
          <button className="vote-button" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      );
    }
    return <p className="page-note">Nothing is contested on {network} right now.</p>;
  }

  const soonest = visibleOpen[0];

  const row = (contest: ContestSummary, isOpen: boolean) => {
    const state = states[contest.keyString];
    const kind = kindFor(contest.key);
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
    } else if (state === 'error') {
      status = '';
    } else {
      status = 'awaiting result';
    }
    const contenders = typeof state === 'object' ? state.tally.contenders.length : 0;
    return (
      <li key={contest.keyString}>
        <a
          className={isOpen ? 'ledger-row' : 'ledger-row ended'}
          href={pollHref(contest.keyString)}
        >
          <span className="ledger-name">
            <KindTitle contest={typeof state === 'object' ? state : contest} />
            {!kindFilter && kind.id !== 'dpns' && (
              <span className="kind-chip">{kind.label}</span>
            )}
            {contenders >= 2 && (
              <span className="contest-flag" title={`${contenders} contenders`}>
                {contenders} contenders
              </span>
            )}
          </span>
          <span className="ledger-bar">
            {state === 'loading' && <span className="bar-skeleton" />}
            {state === 'error' && <span className="mono-label error">tally unavailable</span>}
            {typeof state === 'object' && (
              <BallotBar state={state.tally} mini showLock={kind.choices(state).includes('lock')} />
            )}
          </span>
          <span className="ledger-votes mono-label">
            {typeof state === 'object' ? plural(state.tally.total, 'vote') : ''}
          </span>
          <span className={statusClass}>{status}</span>
        </a>
      </li>
    );
  };

  return (
    <div className="contest-list">
      <KindTabs active={kindFilter} counts={counts} />
      {heading && <h1 className="section-title">{heading}</h1>}
      <div className="status-strip">
        <span className="mono-label">{plural(visibleOpen.length, 'open contest')}</span>
        {soonest?.endsAtMs && (
          <span className="mono-label">
            next closes in {countdown(soonest.endsAtMs, now).text}
          </span>
        )}
        <span className="mono-label">{network}</span>
        {streaming && <span className="mono-label">loading more…</span>}
        <Legend />
      </div>
      <ReadIssues failures={report.failures} caps={report.caps} />

      {total > 6 && (
        <input
          className="search"
          type="search"
          placeholder="Filter contests"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter contests"
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
        <p className="page-note">
          {needle
            ? `No contests match “${filter.trim()}”.`
            : streaming
              ? 'Still reading from Platform…'
              : report.failures.length > 0
                ? 'None found, but some reads failed (see above).'
                : 'No contests of this kind yet.'}
        </p>
      )}
    </div>
  );
}
