import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { chunk, createPump, createWantQueue } from '../../discovery/concurrency';
import { fetchContract } from '../../discovery/contracts';
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
  DPNS_CONTRACT_ID,
  DPNS_VOTE_PERIOD_MS,
  dpnsKeyString,
  dpnsLabel,
  dpnsSpelling,
  fetchDpnsNames,
  fetchUsernames,
  NAME_BATCH,
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
import { TechnicalDetail } from '../components/TechnicalDetail';
import { countdown, fmt, plural, shortId } from '../format';
import { useNow } from '../hooks';
import { kindHref, pollHref } from '../router';
import {
  completeKinds,
  decidedWords,
  emptyMessage,
  isPlaced,
  kindIdOf,
  loaded,
  matchesNeedle,
  mergeByKey,
  namesWinner,
  needsName,
  NOUN,
  orderEnded,
  outcomeOf,
  rowLabel,
  shortDate,
  showDecided,
  shownEnded,
  statesOf,
  statusSentence,
  tallyWants,
  titleOf,
  toNeedle,
  winnerNameOf,
  type DirectoryFacts,
  type EndedSort,
  type RowState,
} from './directoryModel';

/**
 * Vote-state reads in flight at once. Each is small (a tally, ~100–250 ms),
 * and a cold tab places a few dozen undated rows by them while it reads the
 * rows on screen, so the queue is wide.
 */
const TALLY_CONCURRENCY = 12;
/**
 * Username-document batches in flight at once (100 names each). The first
 * rows show once every name of the archive is known, and the archive's
 * pages land nearly together, so their batches go out together too.
 */
const NAME_CONCURRENCY = 8;
/** Decided contests shown at first, and added per "Show more". */
const FIRST_PAGE = 25;
const MORE = 50;
/** The search box appears once a tab has more rows than this. */
const SEARCH_MIN = 10;
/** Show what is known even if the newest-first order is still settling. */
const SHOW_ANYWAY_MS = 20_000;

interface LegendItem {
  label: string;
  color: string;
  hatched?: boolean;
}

function Legend({ items }: { items: LegendItem[] }) {
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
  const items: LegendItem[] = [];
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
          Showing {fmt(c.limit)} from the {c.source}; there are more.
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

/** A username's name cell: as requested while open, as registered once decided. */
function UsernameCell({ contest, isOpen }: { contest: ContestSummary | Contest; isOpen: boolean }) {
  const spelling = dpnsSpelling(contest);
  if (isOpen) return <ContestedName label={spelling.label} />;
  return (
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
}

/** The bar cell: the ballot, or a few words when there is nothing to draw. */
function BarCell({ state, isOpen, showLock }: { state: RowState | undefined; isOpen: boolean; showLock: boolean }) {
  if (state === undefined) return <span className="bar-skeleton" />;
  if (state === 'error') return <span className="mono-label">result unavailable</span>;
  if (isOpen || state.tally.total > 0) {
    return <BallotBar state={state.tally} mini ended={!isOpen} showLock={showLock} />;
  }
  const outcome = outcomeOf(state);
  let note = 'no votes cast';
  if (outcome.unopposed) note = 'only contender';
  else if (outcome.kind === 'awaiting') note = 'no votes';
  return <span className="dir-result-note">{note}</span>;
}

/** The votes cell: "12 votes", a decided score ("12–4"), or "no votes yet". */
function votesText(state: Contest | undefined, isOpen: boolean): string {
  if (!state) return '';
  const total = state.tally.total;
  if (isOpen) return total > 0 ? plural(total, 'vote') : 'no votes yet';
  return outcomeOf(state).score ?? (total > 0 ? plural(total, 'vote') : '');
}

/** One row of the ledger: name, bar, votes, and when it closes or how it ended. */
function LedgerRow({
  contest,
  isOpen,
  facts,
  now,
  showChip,
}: {
  contest: ContestSummary;
  isOpen: boolean;
  facts: DirectoryFacts;
  now: number;
  /** On the All tab, non-username rows say what they are. */
  showChip: boolean;
}) {
  const state = facts.states[contest.keyString];
  const loadedState = loaded(facts, contest.keyString);
  const kind = kindFor(contest.key);
  const timing = contest.endsAtMs ? countdown(contest.endsAtMs, now) : undefined;
  const winnerName = winnerNameOf(contest, facts);
  const outcome = loadedState && !isOpen ? outcomeOf(loadedState) : undefined;
  const title = titleOf(contest, facts);
  const contenders = loadedState?.tally.contenders.length ?? 0;

  let status: ReactNode = '';
  let statusClass = 'ledger-ends mono-label';
  if (isOpen) {
    status = timing ? `closes in ${timing.text}` : '';
    if (timing?.urgent) statusClass += ' urgent';
  } else if (outcome) {
    status = (
      <>
        <span className={`dir-outcome ${outcome.kind.replace(' ', '-')}`}>
          {outcome.kind === 'awaiting' ? 'awaiting result' : outcome.kind}
        </span>
        {outcome.decidedAtMs !== undefined && <span className="dir-date">{shortDate(outcome.decidedAtMs)}</span>}
      </>
    );
  } else if (state === undefined) {
    status = '…';
  }

  const sub =
    outcome?.kind === 'awarded' && namesWinner(kind.id, contenders)
      ? `won by ${winnerName ?? shortId(outcome.winnerId ?? '', 6)}`
      : undefined;
  const chip = showChip && kind.id !== 'dpns' ? NOUN[kind.id] : undefined;

  return (
    <li>
      <a
        className={isOpen ? 'ledger-row' : 'ledger-row ended'}
        href={pollHref(contest.keyString)}
        aria-label={rowLabel({ title, open: isOpen, closes: timing?.text, state, winnerName })}
      >
        <span className="ledger-name">
          <span className="dir-title">
            {kind.id === 'dpns' ? (
              <UsernameCell contest={loadedState ?? contest} isOpen={isOpen} />
            ) : (
              <span className="kind-title">{title}</span>
            )}
            {isOpen && contenders >= 2 && <span className="contest-flag">{contenders} contenders</span>}
          </span>
          {(sub || chip) && (
            <span className="dir-sub">
              {chip && <span className="kind-chip">{chip}</span>}
              {sub}
            </span>
          )}
        </span>
        <span className="ledger-bar">
          <BarCell state={state} isOpen={isOpen} showLock={!!loadedState && kind.choices(loadedState).includes('lock')} />
        </span>
        <span className="ledger-votes mono-label">{votesText(loadedState, isOpen)}</span>
        <span className={statusClass}>{status}</span>
      </a>
    </li>
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
 * cached) shows straight away, with `connecting` as the status. If the
 * connection failed (`sdkError`), whatever is cached stays on screen under
 * the error.
 */
export function OverviewPage({
  sdk,
  network,
  kindFilter,
  connecting,
  sdkError,
}: {
  sdk?: EvoSDK;
  network: Network;
  kindFilter?: KindId;
  connecting?: string;
  sdkError?: string;
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
  // "A while" counts from the connection: a slow SDK download is not the
  // list being slow.
  const connected = sdk !== undefined;
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => setSlow(true), SHOW_ANYWAY_MS);
    return () => clearTimeout(timer);
  }, [kindFilter, connected]);

  useEffect(() => {
    let off = false;
    void loadCachedDirectory(network).then((dir) => {
      if (off) return;
      for (const r of dir.results.values()) {
        if (!r.name) continue;
        const key = decodePollKey(r.keyString);
        const label = key && dpnsLabel(key);
        if (label) rememberDpnsSpelling(label, r.name.label);
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
    return { rows, keys: new Set(rows.map((c) => c.keyString)), states, names };
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
  // A name query first fetches the DPNS contract, which would cost a cold
  // list's first rows a round trip after the archive lands: fetch it while
  // the archive is read (the SDK keeps it for every later query).
  const readsNames = tabKinds.includes('dpns') && !cache?.complete.has('dpns');
  useEffect(() => {
    if (!sdk || !readsNames) return;
    void fetchContract(sdk, DPNS_CONTRACT_ID).catch(() => {
      // The first name query fetches it again.
    });
  }, [sdk, readsNames]);
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
          if (!label || !needsName(dir.results.get(c.keyString)) || requestedLabels.current.has(label)) continue;
          requestedLabels.current.add(label);
          labels.push(label);
        }
        const chunks = chunk(labels, NAME_BATCH);
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
        const append = (prev: ContestSummary[]) => mergeByKey(prev, batch.list);
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
        // A tally-only read that lands late never replaces a full one.
        setSession((prev) =>
          read === fetchContestTally && typeof prev[c.keyString] === 'object' ? prev : { ...prev, [c.keyString]: state },
        );
        if (isStorable(state)) saveCachedResult(network, c.keyString, { result: resultOf(state) });
      } catch {
        // A failed read keeps whatever an earlier one found.
        if (!cancelled) {
          setSession((prev) => (typeof prev[c.keyString] === 'object' ? prev : { ...prev, [c.keyString]: 'error' }));
        }
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

  // The active polls have been read (successfully or not): until then an
  // archive row not in the cache may still be open, so it is held back.
  const activeRead = available && report.finished.includes('active');
  const inTab = (c: ContestSummary) => tabKinds.includes(kindIdOf(c));
  const activeKeys = new Set(active.map((c) => c.keyString));
  const archiveAll = useMemo(() => mergeByKey(archive, cached.rows), [archive, cached.rows]);
  const archiveRows = archiveAll.filter(
    (c) => !activeKeys.has(c.keyString) && inTab(c) && (activeRead || cached.keys.has(c.keyString)),
  );
  // Soonest-closing first (a restarted active run appends its new polls at the end).
  const openRows = active
    .filter((c) => inTab(c) && c.endsAtMs !== undefined && c.endsAtMs > now)
    .sort((a, b) => (a.endsAtMs ?? 0) - (b.endsAtMs ?? 0));
  const expiredRows = active.filter((c) => inTab(c) && (c.endsAtMs === undefined || c.endsAtMs <= now));
  const endedRows = [...expiredRows, ...archiveRows];

  const sourcesFinished = (kind: KindId) =>
    sources.every((s) => (s.id !== 'active' && s.kindId !== kind) || report.finished.includes(s.id));
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
    (settled(kind) && !unplaced.some((c) => kindIdOf(c) === kind));
  // Without Platform there is nothing more to wait for: the cache is all there is.
  const offline = sdkError !== undefined;
  // The newest-first order is final (or shown anyway after a while).
  const ready = available && (slow || offline || tabKinds.every(kindReady));
  // Every name of the tab's archives is known, so its named rows are in
  // order; undated rows (no name document) are still being placed by their
  // tallies, and join the list as they are.
  const orderKnown = tabKinds.every((k) => settled(k) || !!cache?.complete.has(k));
  // The decided rows that can show now (A–Z needs no dates), and whether the list shows yet.
  const decidedRows = shownEnded(endedRows, facts, ready || sort === 'name');
  const showEnded = showDecided({
    orderFinal: ready,
    openRead: activeRead,
    namesKnown: orderKnown,
    placed: decidedRows.length,
    total: endedRows.length,
    page: FIRST_PAGE,
  });
  // Nothing is said about open contests until the active polls are read,
  // however much the cache already shows; "nothing is open" never after a
  // failed read.
  const openFailed = report.failures.some((f) => f.source === 'active' || f.source === 'active polls');
  const listComplete = offline || (ready && report.status !== 'streaming');

  // A kind whose archive was read in full, named and ordered, and whose rows
  // all come back from the cache, is cached as complete: the next visit
  // renders it at once. (Idempotent, so it runs every render.)
  const completeNow =
    sources.length > 0
      ? completeKinds({
          kinds: tabKinds,
          ordered: (k) => !cache?.complete.has(k) && kindReady(k),
          rows: archiveRows,
          facts,
          report,
        })
      : [];
  useEffect(() => {
    for (const k of completeNow) markDirectoryComplete(network, k);
  });

  const needle = toNeedle(filter);
  const matches = (c: ContestSummary) => !needle || matchesNeedle(c, kindFor(c.key), facts, needle);
  const titleFor = (c: ContestSummary) => titleOf(c, facts);

  const visibleOpen = openRows.filter(matches);
  const orderedEnded = orderEnded(decidedRows.filter(matches), facts, sort, titleFor, now);
  const visibleEnded = orderedEnded.slice(0, shown);
  const remaining = orderedEnded.length - visibleEnded.length;

  // The queue: the tab's open rows, then the shown page of decided rows
  // once the named ones are in order, then rows waiting to be placed once
  // the open ones are known (an open contest read too early would miss its
  // documents).
  const wanted = tallyWants({
    open: openRows,
    expired: expiredRows,
    visible: orderKnown || ready ? visibleEnded : [],
    unplaced: activeRead ? unplaced : [],
    facts,
  });
  // Cheap (a filter over at most a few pages of rows), so it runs every render.
  useEffect(() => {
    queue.current?.want(wanted);
  });

  // Winners' usernames for the rows shown ("won by alice"). Usernames are
  // their own winners' names, so only contested ones (2+ contenders) ask.
  const shownRows = [...(activeRead ? visibleOpen : []), ...(showEnded ? visibleEnded : [])];
  const askIds = new Set<string>();
  for (const c of shownRows) {
    const state = loaded(facts, c.keyString);
    const id = state?.winner?.identityId;
    if (!id || identityNames[id]) continue;
    if (namesWinner(kindIdOf(c), state.tally.contenders.length)) askIds.add(id);
  }
  // Runs every render; askedIds keeps each lookup to once.
  const askedIds = useRef(new Set<string>());
  useEffect(() => {
    if (!sdk) return;
    for (const id of askIds) {
      if (askedIds.current.has(id)) continue;
      askedIds.current.add(id);
      fetchUsernames(sdk, id)
        .then((names) => setIdentityNames((prev) => ({ ...prev, [id]: names })))
        .catch(() => {
          // The row keeps its short id.
        });
    }
  });

  // ---- Rendering ----

  // A tab's count shows once its list is complete: "…" while this page
  // reads it, the cached count if a tab's list is not being read (another
  // tab's, or any while Platform is out of reach).
  const counts: Partial<Record<KindId, string>> = {};
  for (const k of kindsFor(network)) {
    const n =
      active.filter((c) => kindIdOf(c) === k.id).length +
      archiveAll.filter((c) => !activeKeys.has(c.keyString) && kindIdOf(c) === k.id).length;
    const read = !offline && sources.length > 0 && (!k.archive || sources.some((s) => s.kindId === k.id));
    if (read) counts[k.id] = kindReady(k.id) && sourcesFinished(k.id) ? fmt(n) : '…';
    else if (cache?.complete.has(k.id)) counts[k.id] = fmt(n);
  }

  const heading = kindFilter ? kindById(kindFilter)?.label : undefined;
  const readList = () => {
    const el = listRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.focus({ preventScroll: true });
  };

  if (!available) {
    return (
      <div className="contest-list">
        <KindTabs network={network} active={kindFilter} counts={counts} />
        <h1 className="dir-heading">{heading}</h1>
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

  // ---- The status sentence ----

  const soonest = openRows[0];
  const sentence = statusSentence({
    connected,
    ready,
    openRead: activeRead,
    openFailed,
    openCount: openRows.length,
    endedCount: endedRows.length,
    decided: decidedWords(endedRows, tabKinds),
    nextCloses: soonest?.endsAtMs ? countdown(soonest.endsAtMs, now).text : undefined,
    connecting,
  });
  const empty = emptyMessage({
    filter,
    connected,
    openRead: activeRead,
    status: report.status,
    failures: report.failures.length,
    kindFilter,
    heading,
    network,
  });

  const nothingShown = visibleOpen.length === 0 && orderedEnded.length === 0;
  // Skeleton rows show while the list is not ready, or while an empty tab
  // cannot be called empty yet; never once Platform is out of reach.
  const loadingRows = !offline && (!ready || (nothingShown && !empty));
  const tabRowCount = openRows.length + endedRows.length;
  const row = (c: ContestSummary, isOpen: boolean) => (
    <LedgerRow key={c.keyString} contest={c} isOpen={isOpen} facts={facts} now={now} showChip={!kindFilter} />
  );

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

      {offline ? (
        <div className="dir-offline" role="alert">
          <p>
            <strong>Could not connect to Dash Platform.</strong>{' '}
            {endedRows.length > 0
              ? 'Showing the results saved on this device. Open contests and newer results need a connection.'
              : 'Check your connection and try again.'}
          </p>
          <TechnicalDetail>{sdkError}</TechnicalDetail>
          <button type="button" className="vote-button" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      ) : (
        <p className="dir-status" role="status" aria-live="polite">
          {sentence.lead && <strong>{sentence.lead}</strong>}
          {sentence.lead && sentence.rest && ' '}
          {sentence.rest}
          {activeRead && ready && report.status === 'streaming' && (
            <span className="mono-label"> Checking for new contests…</span>
          )}
        </p>
      )}
      <DirectoryIssues failures={report.failures} caps={report.caps} />

      <div ref={listRef} tabIndex={-1} className="dir-list" aria-busy={loadingRows}>
        {showEnded && tabRowCount > SEARCH_MIN && (
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

        {activeRead && visibleOpen.length > 0 && (
          <>
            <div className="dir-section-head">
              <h2 className="section-title">Open for voting · {visibleOpen.length}</h2>
              <Legend items={legendFor(statesOf(visibleOpen, facts), false)} />
            </div>
            <ol className="ledger">{visibleOpen.map((c) => row(c, true))}</ol>
          </>
        )}

        {!showEnded ? (
          <>
            <div className="dir-section-head">
              <h2 className="section-title">
                {activeRead && openRows.length > 0 ? 'Recently decided' : 'Loading contests'}
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
                    {sort === 'recent' ? 'Recently decided' : 'Decided, A–Z'}
                    {/* Counted once every row is placed. */}
                    {ready && ` · ${fmt(orderedEnded.length)}`}
                  </h2>
                  <Legend items={legendFor(statesOf(visibleEnded, facts), true)} />
                  {orderedEnded.length > SEARCH_MIN && (
                    <div className="dir-sort" role="group" aria-label="Sort decided contests">
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
                    Show {Math.min(MORE, remaining)} more
                    {ready && <span className="mono-label"> · {fmt(remaining)} not shown</span>}
                  </button>
                )}
              </>
            )}

            {nothingShown &&
              !offline &&
              (ready && empty ? <p className="page-note">{empty}</p> : <SkeletonRows count={3} />)}
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
