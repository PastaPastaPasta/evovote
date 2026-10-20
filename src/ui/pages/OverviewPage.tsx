import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { createPump, createWantQueue } from '../../discovery/concurrency';
import {
  cachedContest,
  isStorable,
  loadCachedDirectory,
  markDirectoryComplete,
  peekCachedDirectory,
  resultOf,
  saveCachedResult,
  type CachedDirectory,
} from '../../discovery/resultCache';
import { subscribeContests, type StreamReport } from '../../discovery/stream';
import type { Cap, Failure } from '../../discovery/types';
import { fetchContest, fetchContestTally } from '../../discovery/voteState';
import {
  DPNS_VOTE_PERIOD_MS,
  dpnsKeyString,
  dpnsLabel,
  dpnsSpelling,
  fetchDpnsNames,
  fetchUsernames,
  rememberDpnsSpelling,
  type DpnsName,
} from '../../kinds/dpns';
import { kindAvailable, kindById, kindFor, kindsFor, sourcesFor } from '../../kinds/registry';
import type { KindId } from '../../kinds/types';
import type { Contest, ContestSummary } from '../../model/contest';
import { decodePollKey } from '../../model/pollKey';
import { switchNetwork, type Network } from '../../sdk/network';
import { ABSTAIN_COLOR, BallotBar, contenderColor, LOCK_COLOR } from '../components/BallotBar';
import { ContestedName } from '../components/ContestedName';
import { OpenContractForm } from '../components/OpenContractForm';
import { countdown, plural, shortId } from '../format';
import { useNow } from '../hooks';
import { kindHref, pollHref } from '../router';
import {
  isPlaced,
  loaded,
  matchesNeedle,
  orderEnded,
  otherName,
  outcomeOf,
  rowLabel,
  shortDate,
  toNeedle,
  type DirectoryFacts,
  type EndedSort,
  type RowState,
} from './directoryModel';

/** Vote-state reads in flight at once. */
const TALLY_CONCURRENCY = 8;
/** Username-document batches in flight at once (100 names each). */
const NAME_CONCURRENCY = 3;
/** Decided contests shown at first, and added per "Show more". */
const FIRST_PAGE = 25;
const MORE = 50;
/** The search box appears once a tab has more rows than this. */
const SEARCH_MIN = 10;
/** Show what is known even if the newest-first order is still settling. */
const SHOW_ANYWAY_MS = 20_000;

const fmt = (n: number) => n.toLocaleString();

/** "a moderator election", for the kind chip on the All tab. */
const CHIP: Record<KindId, string> = {
  dpns: 'username',
  charter: 'moderator election',
  generic: 'other contest',
};

/** "1,036 username contests", "5 moderator elections" for the status sentence. */
function kindCount(kind: KindId, n: number): string {
  const noun = kind === 'dpns' ? 'username contest' : kind === 'charter' ? 'moderator election' : 'other contest';
  return `${fmt(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function Legend({ items }: { items: { label: string; color: string; hatched?: boolean }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="legend" aria-label="Bar colours">
      {items.map((item) => (
        <span key={item.label}>
          <i className={item.hatched ? 'hatched' : undefined} style={{ backgroundColor: item.color }} />{' '}
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** What the bars of some rows can contain, as legend entries. */
function legendFor(states: Contest[], ended: boolean) {
  const items: { label: string; color: string; hatched?: boolean }[] = [];
  const voted = states.filter((s) => s.tally.total > 0);
  if (voted.length === 0) return items;
  items.push({ label: ended ? 'winner' : 'leader', color: contenderColor(0) });
  if (voted.some((s) => (s.tally.contenders[1]?.votes ?? 0) > 0)) {
    items.push({ label: ended ? 'runner-up' : 'challenger', color: contenderColor(1) });
  }
  if (voted.some((s) => s.tally.abstain > 0)) items.push({ label: 'abstain', color: ABSTAIN_COLOR });
  if (voted.some((s) => s.tally.lock > 0)) items.push({ label: 'lock', color: LOCK_COLOR, hatched: true });
  return items;
}

/**
 * Read problems in plain words; the raw messages stay one click away. A
 * failed read is never shown as "none".
 */
function DirectoryIssues({ failures, caps }: { failures: Failure[]; caps: Cap[] }) {
  if (failures.length === 0 && caps.length === 0) return null;
  return (
    <div className="dir-issues" role="status">
      {failures.length > 0 && (
        <p>
          Some contests could not be read from Platform, so this list may be incomplete. Reload the
          page to try again.
        </p>
      )}
      {caps.map((c, i) => (
        <p key={i}>
          Showing the first {fmt(c.limit)} from the {c.source}; there are more.
        </p>
      ))}
      {failures.length > 0 && (
        <details>
          <summary>Technical detail</summary>
          <ul>
            {failures.map((f, i) => (
              <li key={i} className="mono">
                {f.source}: {f.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function KindTabs({
  network,
  active,
  counts,
}: {
  network: Network;
  active?: KindId;
  counts: Partial<Record<KindId, string>>;
}) {
  return (
    <nav className="kind-tabs" aria-label="Contest kinds">
      <a href="#/" className={active ? '' : 'current'} aria-current={active ? undefined : 'page'}>
        All
      </a>
      {kindsFor(network).map((k) => (
        <a
          key={k.id}
          href={kindHref(k.id)}
          className={active === k.id ? 'current' : ''}
          aria-current={active === k.id ? 'page' : undefined}
        >
          {k.label}
          {counts[k.id] !== undefined && <span className="mono-label"> {counts[k.id]}</span>}
        </a>
      ))}
    </nav>
  );
}

function Intro({ network, onRead }: { network: Network; onRead: () => void }) {
  const testnet = network === 'testnet';
  return (
    <section className="dir-intro" aria-labelledby="dir-intro-title">
      <h1 id="dir-intro-title">{testnet ? 'Contested names and moderator elections' : 'Contested usernames'}</h1>
      <p className="dir-intro-line">
        {testnet
          ? 'Masternodes decide contested usernames and elect moderation teams on Dash Platform testnet.'
          : 'Masternodes decide contested usernames on Dash Platform mainnet. Moderator elections arrive with protocol 14.'}
      </p>
      <div className="dir-entry">
        <a href="#/mn">
          <strong>Vote with a masternode</strong>
          <span>Add your masternode’s voting key, then vote on any open contest.</span>
        </a>
        {testnet && (
          <a href="#/m">
            <strong>Run for moderator</strong>
            <span>See which contracts elect moderators and file a team’s charter.</span>
          </a>
        )}
        <button type="button" onClick={onRead}>
          <strong>Read &amp; discuss</strong>
          <span>Every contest has a page with its tally and a discussion thread.</span>
        </button>
      </div>
    </section>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <ol className="ledger" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div className="ledger-row skeleton">
            <span className="ledger-name">
              <span className="dir-skel" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
            </span>
            <span className="ledger-bar">
              <span className="bar-skeleton" />
            </span>
            <span className="ledger-votes" />
            <span className="ledger-ends" />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The directory of every contest Platform knows about (`#/`), or of one kind
 * (`#/k/<kind>`). Each tab reads only its own lists (the active polls plus
 * its kinds' archives), fills tallies only for the rows on screen, and keeps
 * decided results in IndexedDB so a return visit renders at once. Open
 * contests come first, soonest-closing; then decided ones, newest first.
 *
 * `sdk` may be absent while Platform connects: the layout (and anything
 * cached) shows straight away.
 */
export function OverviewPage({
  sdk,
  network,
  kindFilter,
}: {
  sdk?: EvoSDK;
  network: Network;
  kindFilter?: KindId;
}) {
  const now = useNow();
  const available = kindFilter === undefined || kindAvailable(kindFilter, network);
  const sources = useMemo(
    () => (available ? sourcesFor(network, kindFilter) : []),
    [available, network, kindFilter],
  );
  const tabKinds = useMemo<KindId[]>(
    () => (kindFilter ? [kindFilter] : kindsFor(network).map((k) => k.id)),
    [kindFilter, network],
  );

  const [cache, setCache] = useState<CachedDirectory | undefined>(() => peekCachedDirectory(network));
  const [active, setActive] = useState<ContestSummary[]>([]);
  const [archive, setArchive] = useState<ContestSummary[]>([]);
  const [session, setSession] = useState<Record<string, RowState>>({});
  const [sessionNames, setSessionNames] = useState<Record<string, DpnsName>>({});
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [namesPending, setNamesPending] = useState(0);
  const [identityNames, setIdentityNames] = useState<Record<string, readonly string[]>>({});
  const [report, setReport] = useState<StreamReport>({
    status: 'streaming',
    failures: [],
    caps: [],
    finished: [],
  });
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<EndedSort>('recent');
  const [shown, setShown] = useState(FIRST_PAGE);
  const [slow, setSlow] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // A new tab (the page stays mounted across tabs) starts on its first
  // page, with the search cleared.
  const [tabFor, setTabFor] = useState(kindFilter);
  if (tabFor !== kindFilter) {
    setTabFor(kindFilter);
    setShown(FIRST_PAGE);
    setFilter('');
    setSlow(false);
  }
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SHOW_ANYWAY_MS);
    return () => clearTimeout(timer);
  }, [kindFilter]);

  useEffect(() => {
    let off = false;
    void loadCachedDirectory(network).then((dir) => {
      if (off) return;
      for (const r of dir.results.values()) {
        const key = r.name ? decodePollKey(r.keyString) : undefined;
        const label = key && dpnsLabel(key);
        if (r.name && label) rememberDpnsSpelling(label, r.name.label);
      }
      setCache(dir);
    });
    return () => {
      off = true;
    };
  }, [network]);

  // What the cache contributes: decided rows, their results and names.
  const cached = useMemo(() => {
    const rows: ContestSummary[] = [];
    const states: Record<string, RowState> = {};
    const names: Record<string, DpnsName> = {};
    for (const r of cache?.results.values() ?? []) {
      const key = decodePollKey(r.keyString);
      if (!key) continue;
      rows.push({ key, keyString: r.keyString });
      const contest = cachedContest(r);
      if (contest) states[r.keyString] = contest;
      const label = dpnsLabel(key);
      if (r.name && label) names[label] = r.name;
    }
    return { rows, states, names };
  }, [cache]);

  const facts: DirectoryFacts = useMemo(
    () => ({
      states: { ...cached.states, ...session },
      names: { ...cached.names, ...sessionNames },
      identityNames,
      dpnsVotePeriodMs: DPNS_VOTE_PERIOD_MS[network],
    }),
    [cached, session, sessionNames, identityNames, network],
  );

  // Username documents, in batches of 100 as archive pages land: they give
  // the registered spelling and, for the whole archive at once, the order.
  const requestedLabels = useRef(new Set<string>());
  const namePump = useRef<ReturnType<typeof createPump<string[]>> | undefined>(undefined);
  useEffect(() => {
    if (!sdk) return;
    let cancelled = false;
    const pump = createPump<string[]>(NAME_CONCURRENCY, (labels) =>
      fetchDpnsNames(sdk, labels)
        .then((found) => {
          if (cancelled) return;
          const add: Record<string, DpnsName> = {};
          for (const [label, name] of found) {
            add[label] = name;
            saveCachedResult(network, dpnsKeyString(label), { name });
          }
          setSessionNames((prev) => ({ ...prev, ...add }));
        })
        .catch(() => {
          // Unnamed rows fall back to reading their tallies.
        })
        .finally(() => {
          if (cancelled) return;
          setChecked((prev) => new Set([...prev, ...labels]));
          setNamesPending((n) => n - 1);
        }),
    );
    namePump.current = pump;
    const requested = requestedLabels.current;
    return () => {
      cancelled = true;
      pump.cancel();
      namePump.current = undefined;
      // Whatever was queued is dropped; let a remount ask again.
      requested.clear();
      setNamesPending(0);
    };
  }, [sdk, network]);

  useEffect(() => {
    if (!sdk || sources.length === 0) return;
    let cancelled = false;
    const requestNames = (list: ContestSummary[]) => {
      void loadCachedDirectory(network).then((dir) => {
        if (cancelled || !namePump.current) return;
        const labels: string[] = [];
        for (const c of list) {
          const label = dpnsLabel(c.key);
          const record = dir.results.get(c.keyString);
          if (!label || record?.name || record?.result || requestedLabels.current.has(label)) continue;
          requestedLabels.current.add(label);
          labels.push(label);
        }
        const chunks: string[][] = [];
        for (let i = 0; i < labels.length; i += 100) chunks.push(labels.slice(i, i + 100));
        if (chunks.length === 0) return;
        setNamesPending((n) => n + chunks.length);
        namePump.current.push(chunks);
      });
    };
    const unsubscribe = subscribeContests(
      sdk,
      sources,
      (batch) => {
        if (cancelled) return;
        // Dedupe: a reused run replays its batches, and StrictMode mounts twice in dev.
        const append = (prev: ContestSummary[]) => {
          const have = new Set(prev.map((c) => c.keyString));
          const fresh = batch.list.filter((c) => !have.has(c.keyString));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        };
        if (batch.phase === 'active') setActive(append);
        else setArchive(append);
        if (batch.source === 'dpns archive') requestNames(batch.list);
      },
      (next) => {
        if (!cancelled) setReport(next);
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sdk, sources, network]);

  // Tallies: one queue for the page's lifetime, re-prioritised on every
  // render to exactly the rows this tab shows (then rows still unplaced).
  const queue = useRef<ReturnType<typeof createWantQueue<ContestSummary>> | undefined>(undefined);
  useEffect(() => {
    if (!sdk) return;
    let cancelled = false;
    const q = createWantQueue<ContestSummary>(TALLY_CONCURRENCY, jobKey, async (c) => {
      // Open contests read documents too (a username's requested spelling).
      const read = c.endsAtMs !== undefined ? fetchContest : fetchContestTally;
      try {
        const state = await read(sdk, c);
        if (cancelled) return;
        setSession((prev) => ({ ...prev, [c.keyString]: state }));
        if (isStorable(state)) saveCachedResult(network, c.keyString, { result: resultOf(state) });
      } catch {
        if (!cancelled) setSession((prev) => ({ ...prev, [c.keyString]: 'error' }));
      }
    });
    queue.current = q;
    return () => {
      cancelled = true;
      q.cancel();
      queue.current = undefined;
    };
  }, [sdk, network]);

  // ---- The tab's rows ----

  const inTab = (c: ContestSummary) => tabKinds.includes(kindFor(c.key).id);
  const activeKeys = new Set(active.map((c) => c.keyString));
  const archiveAll = useMemo(() => {
    const seen = new Set<string>();
    const out: ContestSummary[] = [];
    for (const c of [...archive, ...cached.rows]) {
      if (seen.has(c.keyString)) continue;
      seen.add(c.keyString);
      out.push(c);
    }
    return out;
  }, [archive, cached.rows]);
  const archiveRows = archiveAll.filter((c) => !activeKeys.has(c.keyString) && inTab(c));
  const openRows = active.filter((c) => inTab(c) && c.endsAtMs !== undefined && c.endsAtMs > now);
  const expiredRows = active.filter((c) => inTab(c) && (c.endsAtMs === undefined || c.endsAtMs <= now));
  const endedRows = [...expiredRows, ...archiveRows];

  const sourceIdsOf = (kind: KindId) =>
    sources.filter((s) => s.id === 'active' || s.kindId === kind).map((s) => s.id);
  const sourcesFinished = (kind: KindId) =>
    sourceIdsOf(kind).every((id) => report.finished.includes(id));
  // Rows whose place in the newest-first order needs their tally: usernames
  // with no name document (locked, mostly) and decided rows of other kinds.
  const unplaced = archiveRows.filter((c) => {
    if (isPlaced(c, facts)) return false;
    const label = dpnsLabel(c.key);
    return label === undefined || checked.has(label);
  });
  const settled = (kind: KindId) =>
    sourcesFinished(kind) && (kind !== 'dpns' || namesPending === 0);
  const kindReady = (kind: KindId) =>
    !!cache?.complete.has(kind) ||
    (settled(kind) && !unplaced.some((c) => kindFor(c.key).id === kind));
  const ready = available && (slow || tabKinds.every(kindReady));
  // Open contests need only the active polls: they show before the archive is ordered.
  const openReady = ready || (available && report.finished.includes('active'));
  const listComplete = ready && report.status !== 'streaming';

  // A kind whose archive was read, named and ordered without failures is
  // cached as complete: the next visit renders it at once.
  const completeNow = tabKinds.filter(
    (k) => sources.length > 0 && !cache?.complete.has(k) && settled(k) && kindReady(k) && report.failures.length === 0,
  );
  const completeKey = completeNow.join(',');
  useEffect(() => {
    if (!completeKey) return;
    for (const k of completeKey.split(',')) markDirectoryComplete(network, k);
  }, [completeKey, network]);

  const needle = toNeedle(filter);
  const matches = (c: ContestSummary) => !needle || matchesNeedle(c, kindFor(c.key), facts, needle);
  const titleOf = (c: ContestSummary) => kindFor(c.key).title(loaded(facts, c.keyString) ?? c);

  const visibleOpen = openRows.filter(matches);
  const orderedEnded = orderEnded(endedRows.filter(matches), facts, sort, titleOf, now);
  const visibleEnded = orderedEnded.slice(0, shown);
  const remaining = orderedEnded.length - visibleEnded.length;

  // The queue: every open row of the tab, then the shown page of decided
  // rows once their order is settled, then rows waiting to be placed.
  const orderKnown = tabKinds.every((k) => settled(k) || !!cache?.complete.has(k));
  const wanted = [
    ...openRows,
    ...expiredRows,
    ...(orderKnown ? visibleEnded : []),
    ...unplaced,
  ].filter((c) => facts.states[c.keyString] === undefined);
  // Cheap (a filter over at most a few pages of rows), so it runs every render.
  useEffect(() => {
    queue.current?.want(wanted);
  }, [wanted, sdk]);

  // Winners' usernames for the rows shown ("won by alice"). Usernames are
  // their own winners' names, so only contested ones (2+ contenders) ask.
  const shownRows = [...(openReady ? visibleOpen : []), ...(ready ? visibleEnded : [])];
  const askIds = new Set<string>();
  for (const c of shownRows) {
    const state = loaded(facts, c.keyString);
    const id = state?.winner?.identityId;
    if (!id || identityNames[id]) continue;
    if (kindFor(c.key).id !== 'dpns' || state.tally.contenders.length >= 2) askIds.add(id);
  }
  const askKey = [...askIds].sort().join(' ');
  const askedIds = useRef(new Set<string>());
  useEffect(() => {
    if (!sdk || !askKey) return;
    for (const id of askKey.split(' ')) {
      if (askedIds.current.has(id)) continue;
      askedIds.current.add(id);
      void fetchUsernames(sdk, id).then((names) =>
        setIdentityNames((prev) => ({ ...prev, [id]: names })),
      );
    }
  }, [askKey, sdk]);

  // ---- Rendering ----

  // A tab's count shows once its list is complete: "…" while this page
  // reads it, the cached count if another tab's list is not being read.
  const counts: Partial<Record<KindId, string>> = {};
  for (const k of kindsFor(network)) {
    const n =
      active.filter((c) => kindFor(c.key).id === k.id).length +
      archiveAll.filter((c) => !activeKeys.has(c.keyString) && kindFor(c.key).id === k.id).length;
    const read = sources.length > 0 && (!k.archive || sources.some((s) => s.kindId === k.id));
    if (read) counts[k.id] = kindReady(k.id) && sourcesFinished(k.id) ? fmt(n) : '…';
    else if (cache?.complete.has(k.id)) counts[k.id] = fmt(n);
  }

  const readList = () => {
    const el = listRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.focus({ preventScroll: true });
  };

  if (!available) {
    return (
      <div className="contest-list">
        <KindTabs network={network} active={kindFilter} counts={counts} />
        <h1 className="dir-heading">{kindById(kindFilter ?? '')?.label}</h1>
        <p className="page-note">
          Moderator elections arrive on {network} with protocol 14. Until then they run on
          testnet.{' '}
          <button type="button" className="link-button" onClick={() => switchNetwork('testnet')}>
            Switch to testnet
          </button>
        </p>
      </div>
    );
  }

  const winnerNameOf = (c: ContestSummary, state: Contest | undefined) => {
    const id = state?.winner?.identityId;
    if (!id) return undefined;
    const names = identityNames[id];
    return kindFor(c.key).id === 'dpns' ? otherName(names, dpnsLabel(c.key)) : names?.[0];
  };

  const row = (contest: ContestSummary, isOpen: boolean) => {
    const state = facts.states[contest.keyString];
    const contest_ = typeof state === 'object' ? state : undefined;
    const kind = kindFor(contest.key);
    const timing = contest.endsAtMs ? countdown(contest.endsAtMs, now) : undefined;
    const winnerName = winnerNameOf(contest, contest_);
    const outcome = contest_ && !isOpen ? outcomeOf(contest_) : undefined;
    const title = titleOf(contest);

    let name: ReactNode;
    if (kind.id === 'dpns') {
      const spelling = dpnsSpelling(contest_ ?? contest);
      name = isOpen ? (
        <ContestedName label={spelling.label} />
      ) : (
        <span
          className={spelling.known ? 'dir-name' : 'dir-name normalized'}
          title={
            spelling.known
              ? undefined
              : 'Shown in normalized form (lowercase, o→0, i/l→1): the registered spelling could not be read.'
          }
        >
          {spelling.label}
        </span>
      );
    } else {
      name = <span className="kind-title">{title}</span>;
    }

    let bar: ReactNode;
    let votes = '';
    if (state === undefined) {
      bar = <span className="bar-skeleton" />;
    } else if (state === 'error') {
      bar = <span className="mono-label">result unavailable</span>;
    } else if (isOpen || state.tally.total > 0) {
      bar = (
        <BallotBar state={state.tally} mini ended={!isOpen} showLock={kind.choices(state).includes('lock')} />
      );
    } else {
      bar = (
        <span className="dir-result-note">
          {outcome?.unopposed ? 'only contender' : outcome?.kind === 'awaiting' ? 'no votes' : 'no votes cast'}
        </span>
      );
    }
    if (contest_) {
      if (isOpen) votes = contest_.tally.total > 0 ? plural(contest_.tally.total, 'vote') : 'no votes yet';
      else if (outcome?.score) votes = outcome.score;
      else if (contest_.tally.total > 0) votes = plural(contest_.tally.total, 'vote');
    }

    let status: ReactNode;
    let statusClass = 'ledger-ends mono-label';
    if (isOpen) {
      status = timing ? `closes in ${timing.text}` : '';
      if (timing?.urgent) statusClass += ' urgent';
    } else if (outcome) {
      const word = outcome.kind === 'awaiting' ? 'awaiting result' : outcome.kind;
      status = (
        <>
          <span className={`dir-outcome ${outcome.kind.replace(' ', '-')}`}>{word}</span>
          {outcome.decidedAtMs !== undefined && <span className="dir-date">{shortDate(outcome.decidedAtMs)}</span>}
        </>
      );
    } else if (state === undefined) {
      status = '…';
    } else {
      status = '';
    }

    const contenders = contest_?.tally.contenders.length ?? 0;
    const sub =
      !isOpen && outcome?.kind === 'awarded' && (kind.id !== 'dpns' || contenders >= 2)
        ? `won by ${winnerName ?? shortId(outcome.winnerId ?? '', 6)}`
        : undefined;

    // On the All tab, non-username rows say what they are.
    const chip = !kindFilter && kind.id !== 'dpns' ? CHIP[kind.id] : undefined;

    return (
      <li key={contest.keyString}>
        <a
          className={isOpen ? 'ledger-row' : 'ledger-row ended'}
          href={pollHref(contest.keyString)}
          aria-label={rowLabel({ title, open: isOpen, closes: timing?.text, state, winnerName })}
        >
          <span className="ledger-name">
            <span className="dir-title">
              {name}
              {isOpen && contenders >= 2 && <span className="contest-flag">{contenders} contenders</span>}
            </span>
            {(sub || chip) && (
              <span className="dir-sub">
                {chip && <span className="kind-chip">{chip}</span>}
                {sub}
              </span>
            )}
          </span>
          <span className="ledger-bar">{bar}</span>
          <span className="ledger-votes mono-label">{votes}</span>
          <span className={statusClass}>{status}</span>
        </a>
      </li>
    );
  };

  // ---- The status sentence ----

  const endedByKind = new Map<KindId, number>();
  for (const c of endedRows) {
    const k = kindFor(c.key).id;
    endedByKind.set(k, (endedByKind.get(k) ?? 0) + 1);
  }
  const decidedWords = joinWords(
    tabKinds.filter((k) => (endedByKind.get(k) ?? 0) > 0).map((k) => kindCount(k, endedByKind.get(k) ?? 0)),
  );
  const soonest = openRows[0];
  let sentence: ReactNode;
  if (!sdk && !ready) {
    sentence = 'Connecting to Dash Platform…';
  } else if (openReady && openRows.length > 0) {
    sentence = (
      <>
        <strong>{plural(openRows.length, 'contest')} open for voting.</strong>
        {soonest?.endsAtMs && ` The next closes in ${countdown(soonest.endsAtMs, now).text}.`}
        {!ready
          ? ' Reading decided contests…'
          : decidedWords && ` ${decidedWords} decided so far.`}
      </>
    );
  } else if (!ready) {
    const found = openRows.length + endedRows.length;
    sentence = found > 0 ? `Reading contests from Platform… ${fmt(found)} found so far.` : 'Reading contests from Platform…';
  } else if (endedRows.length > 0) {
    sentence = (
      <>
        <strong>Nothing is open for voting right now.</strong> {decidedWords}{' '}
        {endedRows.length === 1 ? 'has' : 'have'} been decided.
      </>
    );
  } else {
    sentence = '';
  }

  const tabRowCount = openRows.length + endedRows.length;
  const heading = kindFilter ? kindById(kindFilter)?.label : undefined;
  const openStates = visibleOpen.map((c) => loaded(facts, c.keyString)).filter((s): s is Contest => !!s);
  const endedStates = visibleEnded.map((c) => loaded(facts, c.keyString)).filter((s): s is Contest => !!s);

  return (
    <div className="contest-list" data-loading={listComplete ? 'false' : 'true'}>
      {!kindFilter && <Intro network={network} onRead={readList} />}
      <KindTabs network={network} active={kindFilter} counts={counts} />
      {heading && <h1 className="dir-heading">{heading}</h1>}
      {kindFilter === 'generic' && (
        <details className="dir-browse">
          <summary>Browse a contract by id…</summary>
          <OpenContractForm network={network} />
        </details>
      )}

      <p className="dir-status" role="status" aria-live="polite">
        {sentence}
        {ready && report.status === 'streaming' && <span className="mono-label"> Checking for new contests…</span>}
      </p>
      <DirectoryIssues failures={report.failures} caps={report.caps} />

      <div ref={listRef} tabIndex={-1} className="dir-list" aria-busy={!ready}>
        {ready && tabRowCount > SEARCH_MIN && (
          <input
            className="search"
            type="search"
            placeholder="Search usernames, contracts or identities"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setShown(FIRST_PAGE);
            }}
            aria-label="Search contests by username, contract or identity"
          />
        )}

        {openReady && visibleOpen.length > 0 && (
          <>
            <div className="dir-section-head">
              <h2 className="section-title">Open for voting · {visibleOpen.length}</h2>
              <Legend items={legendFor(openStates, false)} />
            </div>
            <ol className="ledger">{visibleOpen.map((c) => row(c, true))}</ol>
          </>
        )}

        {!ready ? (
          <>
            <div className="dir-section-head">
              <h2 className="section-title">
                {!sdk ? 'Connecting' : openReady && openRows.length > 0 ? 'Recently decided' : 'Loading contests'}
              </h2>
            </div>
            <SkeletonRows count={5} />
          </>
        ) : (
          <>
            {orderedEnded.length > 0 && (
              <>
                <div className="dir-section-head">
                  <h2 className="section-title">
                    {sort === 'recent' ? 'Recently decided' : 'Decided, A–Z'} · {fmt(orderedEnded.length)}
                  </h2>
                  <Legend items={legendFor(endedStates, true)} />
                  {orderedEnded.length > SEARCH_MIN && (
                    <div className="segmented dir-sort" role="group" aria-label="Sort decided contests">
                      <button type="button" aria-pressed={sort === 'recent'} onClick={() => { setSort('recent'); setShown(FIRST_PAGE); }}>
                        Newest
                      </button>
                      <button type="button" aria-pressed={sort === 'name'} onClick={() => { setSort('name'); setShown(FIRST_PAGE); }}>
                        A–Z
                      </button>
                    </div>
                  )}
                </div>
                <ol className="ledger">{visibleEnded.map((c) => row(c, false))}</ol>
                {remaining > 0 && (
                  <button type="button" className="vote-button ghost dir-more" onClick={() => setShown((n) => n + MORE)}>
                    Show {Math.min(MORE, remaining)} more <span className="mono-label">· {fmt(remaining)} not shown</span>
                  </button>
                )}
              </>
            )}

            {visibleOpen.length === 0 && orderedEnded.length === 0 && (
              <p className="page-note">
                {needle
                  ? `No contests match “${filter.trim()}”.`
                  : report.status === 'error'
                    ? 'Contests could not be read from Platform. Check your connection and reload the page.'
                    : report.failures.length > 0
                      ? 'None found, but some reads failed (see above).'
                      : kindFilter === 'generic'
                        ? `No other contract has a contested resource on ${network} yet. Browse a contract by id to see its contested indices.`
                        : kindFilter
                          ? `No ${heading?.toLowerCase() ?? 'contests'} on ${network} yet.`
                          : `Nothing is contested on ${network} right now.`}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The queue key of a row's tally read: open rows read documents too. */
function jobKey(c: ContestSummary): string {
  return c.endsAtMs !== undefined ? `${c.keyString}|full` : c.keyString;
}
