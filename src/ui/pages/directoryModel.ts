import { isStorable, type CachedResult } from '../../discovery/resultCache';
import type { StreamReport, StreamStatus } from '../../discovery/stream';
import { dpnsLabel, normalizedUsername, normalizeDpnsLabel, stripDash, type DpnsName } from '../../kinds/dpns';
import { kindFor } from '../../kinds/registry';
import type { ContestKind, KindId } from '../../kinds/types';
import type { Contest, ContestSummary } from '../../model/contest';
import type { Network } from '../../sdk/network';
import { fmt, plural } from '../format';

/**
 * The directory's pure logic: what a row says, where it sorts, and what a
 * search matches. Kept out of the page so it can be tested without React or
 * Platform.
 */

export type RowState = Contest | 'error';

/** What the directory knows beyond the contest list itself. */
export interface DirectoryFacts {
  states: Readonly<Record<string, RowState>>;
  /** Registered username documents, by normalized label. */
  names: Readonly<Record<string, DpnsName>>;
  /** Usernames of winners, by identity id. */
  identityNames: Readonly<Record<string, readonly string[]>>;
  /** How long a username vote runs: a name's registration plus this ≈ its decision. */
  dpnsVotePeriodMs: number;
}

export type EndedSort = 'recent' | 'name';

/** The kind of a row. */
export function kindIdOf(c: ContestSummary): KindId {
  return kindFor(c.key).id;
}

/**
 * Whether a decided row's winner needs a name of its own ("won by alice"):
 * a username's winner is the name itself unless others contended for it.
 */
export function namesWinner(kind: KindId, contenders: number): boolean {
  return kind !== 'dpns' || contenders >= 2;
}

/** The loaded contest of a row, if any. */
export function loaded(facts: DirectoryFacts, keyString: string): Contest | undefined {
  const s = facts.states[keyString];
  return typeof s === 'object' ? s : undefined;
}

/** The loaded contests of some rows, skipping rows not (or not readably) loaded. */
export function statesOf(rows: readonly ContestSummary[], facts: DirectoryFacts): Contest[] {
  return rows.map((c) => loaded(facts, c.keyString)).filter((s): s is Contest => !!s);
}

/** A row's title, from its loaded contest when there is one. */
export function titleOf(c: ContestSummary, facts: DirectoryFacts): string {
  return kindFor(c.key).title(loaded(facts, c.keyString) ?? c);
}

/** `base` plus the items of `extra` whose key it lacks; `base` itself when none are new. */
export function mergeByKey(base: ContestSummary[], extra: readonly ContestSummary[]): ContestSummary[] {
  const have = new Set(base.map((c) => c.keyString));
  const fresh = extra.filter((c) => {
    if (have.has(c.keyString)) return false;
    have.add(c.keyString);
    return true;
  });
  return fresh.length > 0 ? [...base, ...fresh] : base;
}

/**
 * Whether a username's name document is worth asking for, given what the
 * cache holds: not once it is known, nor for a contest decided without a
 * winner (locked or none: no name document exists). An awarded result alone
 * does not do: it carries no spelling.
 */
export function needsName(record: CachedResult | undefined): boolean {
  if (record?.name) return false;
  return !record?.result || record.result.winner.kind === 'identity';
}

/**
 * Whether a decided row comes back, in its place, from the cache alone on
 * the next visit: by its registered name (a username) or its stored result.
 */
export function isRemembered(c: ContestSummary, facts: DirectoryFacts): boolean {
  const label = dpnsLabel(c.key);
  if (label !== undefined && facts.names[label]?.createdAtMs !== undefined) return true;
  const state = loaded(facts, c.keyString);
  return state !== undefined && isStorable(state);
}

/**
 * The kinds of a tab whose decided list can be cached as complete: every
 * source finished without a failure or a cap, and every decided row of the
 * kind will come back from the cache (none unread, failed or undecided).
 */
export function completeKinds(args: {
  kinds: readonly KindId[];
  /** The kind's sources finished and every row of it is placed. */
  ordered: (kind: KindId) => boolean;
  rows: readonly ContestSummary[];
  facts: DirectoryFacts;
  report: Pick<StreamReport, 'failures' | 'caps'>;
}): KindId[] {
  const { kinds, ordered, rows, facts, report } = args;
  if (report.failures.length > 0 || report.caps.length > 0) return [];
  return kinds.filter((k) => ordered(k) && rows.every((c) => kindIdOf(c) !== k || isRemembered(c, facts)));
}

/**
 * When an ended contest was decided, for ordering newest first. A username
 * with a registered name sorts by its registration plus the voting period
 * (known for the whole archive from a few batched reads, and stable: it does
 * not move when its tally loads); everything else by the deciding block,
 * once its tally is read. A contest past its end but not yet finalized sorts
 * by its end.
 */
export function recency(c: ContestSummary, facts: DirectoryFacts): number | undefined {
  const label = dpnsLabel(c.key);
  const created = label !== undefined ? facts.names[label]?.createdAtMs : undefined;
  if (created !== undefined) return created + facts.dpnsVotePeriodMs;
  return loaded(facts, c.keyString)?.winner?.decidedAtMs ?? c.endsAtMs;
}

/** True once a row's place in the newest-first order is known (or cannot be). */
export function isPlaced(c: ContestSummary, facts: DirectoryFacts): boolean {
  return recency(c, facts) !== undefined || facts.states[c.keyString] !== undefined;
}

/**
 * The decided rows a tab shows. Until its newest-first order is final, only
 * rows already placed in it: a row whose date is still being read would
 * otherwise sit at the bottom, by name, and then jump. Once the order is
 * final (or shown anyway), every row.
 */
export function shownEnded(
  rows: readonly ContestSummary[],
  facts: DirectoryFacts,
  orderFinal: boolean,
): readonly ContestSummary[] {
  return orderFinal ? rows : rows.filter((c) => isPlaced(c, facts));
}

/**
 * Whether a tab's decided list shows yet. At once when its order is final;
 * before that, once open contests are known (an archive row not in the
 * cache may still be open until then), every name is in (so the named rows
 * are in order), and the rows already placed fill the first page: a short
 * list comes in whole rather than row by row.
 */
export function showDecided(s: {
  orderFinal: boolean;
  openRead: boolean;
  namesKnown: boolean;
  placed: number;
  total: number;
  page: number;
}): boolean {
  if (s.orderFinal) return true;
  return s.openRead && s.namesKnown && s.placed >= Math.min(s.page, s.total);
}

/**
 * What the tally queue reads, most urgent first: every open row (always
 * read in full, so even one with a state is asked again; the queue runs
 * each full read once), then the unread rows among the expired ones, the
 * decided rows on screen, and the rows still waiting for a date to be
 * placed; each once. Nothing else: a decided row off screen with a known
 * date is never read.
 */
export function tallyWants(args: {
  open: readonly ContestSummary[];
  expired: readonly ContestSummary[];
  visible: readonly ContestSummary[];
  unplaced: readonly ContestSummary[];
  facts: DirectoryFacts;
}): ContestSummary[] {
  const { open, expired, visible, unplaced, facts } = args;
  const unread = [...expired, ...visible, ...unplaced].filter((c) => facts.states[c.keyString] === undefined);
  return mergeByKey([...open], unread);
}

/**
 * Ended contests in display order. Contests still awaiting their result come
 * first, then decided ones newest first (or by name); rows whose date is
 * unknown go last, by name.
 */
export function orderEnded(
  rows: readonly ContestSummary[],
  facts: DirectoryFacts,
  sort: EndedSort,
  title: (c: ContestSummary) => string,
  now = Date.now(),
): ContestSummary[] {
  const byName = (a: ContestSummary, b: ContestSummary) => title(a).localeCompare(title(b));
  const awaiting = (c: ContestSummary) =>
    c.endsAtMs !== undefined && c.endsAtMs <= now && !loaded(facts, c.keyString)?.winner;
  return [...rows].sort((a, b) => {
    const wa = awaiting(a);
    const wb = awaiting(b);
    if (wa !== wb) return wa ? -1 : 1;
    if (sort === 'name') return byName(a, b);
    const ra = recency(a, facts);
    const rb = recency(b, facts);
    if (ra === undefined && rb === undefined) return byName(a, b);
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return rb - ra || byName(a, b);
  });
}

/** A search as typed, plus its username-normalized form ("Bob.dash" → "b0b"). */
export interface Needle {
  raw: string;
  lower: string;
  normalized: string;
}

export function toNeedle(input: string): Needle | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const lower = stripDash(raw.toLowerCase());
  return { raw, lower, normalized: normalizeDpnsLabel(lower) };
}

/**
 * Whether a row matches a search: its title, a username in normalized form
 * (so "bob" finds "B0b"), full contract and index ids, and the identity ids
 * and usernames of contenders, winners and owners.
 */
export function matchesNeedle(
  c: ContestSummary,
  kind: ContestKind,
  facts: DirectoryFacts,
  needle: Needle,
): boolean {
  const state = loaded(facts, c.keyString);
  // A username's title ends in ".dash" like every other: match the name itself.
  const title = stripDash(kind.title(state ?? c).toLowerCase());
  if (title.includes(needle.lower)) return true;
  const label = dpnsLabel(c.key);
  if (label !== undefined && needle.normalized && label.includes(needle.normalized)) return true;
  // Ids are matched whole (or as a long prefix), case-sensitively: base58 is.
  const idMatch = (id: string | undefined) =>
    id !== undefined && (id === needle.raw || (needle.raw.length >= 6 && id.startsWith(needle.raw)));
  if (idMatch(c.key.contractId)) return true;
  if (c.key.indexValues.some((v) => v.type === 'identifier' && idMatch(v.value))) return true;
  const ids = new Set<string>();
  if (label !== undefined) {
    const owner = facts.names[label]?.ownerId;
    if (owner) ids.add(owner);
  }
  for (const contender of state?.tally.contenders ?? []) ids.add(contender.identityId);
  if (state?.winner?.identityId) ids.add(state.winner.identityId);
  for (const id of ids) {
    if (idMatch(id)) return true;
    const names = facts.identityNames[id] ?? [];
    if (names.some((n) => normalizedUsername(n).includes(needle.normalized))) return true;
  }
  return false;
}

/** How an ended contest came out, in the words a row shows. */
export interface Outcome {
  kind: 'awarded' | 'locked' | 'no winner' | 'awaiting';
  /** "12–4": the winner's votes against the next best (Lock counts as a side). */
  score?: string;
  /** The winner was the only contender and nobody voted against. */
  unopposed: boolean;
  winnerId?: string;
  decidedAtMs?: number;
}

export function outcomeOf(c: Contest): Outcome {
  const { contenders, lock } = c.tally;
  const winner = c.winner;
  const decidedAtMs = winner?.decidedAtMs;
  if (!winner) return { kind: 'awaiting', unopposed: false };
  if (winner.kind === 'identity') {
    const top = contenders.find((x) => x.identityId === winner.identityId)?.votes ?? 0;
    const others = contenders.filter((x) => x.identityId !== winner.identityId).map((x) => x.votes);
    const next = Math.max(lock, ...others, 0);
    const unopposed = others.length === 0 && lock === 0;
    return {
      kind: 'awarded',
      score: unopposed || c.tally.total === 0 ? undefined : `${top}–${next}`,
      unopposed,
      winnerId: winner.identityId,
      decidedAtMs,
    };
  }
  if (winner.kind === 'locked') {
    const best = Math.max(0, ...contenders.map((x) => x.votes));
    return {
      kind: 'locked',
      score: c.tally.total === 0 ? undefined : `${lock}–${best}`,
      unopposed: false,
      decidedAtMs,
    };
  }
  return { kind: 'no winner', unopposed: false, decidedAtMs };
}

/** "Oct 15, 2026": the decided date on a row. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A username that is not the contest's own name, to tell its winner apart. */
function otherName(names: readonly string[] | undefined, normalized?: string): string | undefined {
  return names?.find((n) => normalizedUsername(n) !== normalized);
}

/**
 * The username of a row's winner, to show "won by alice": for a username
 * contest, a name of the winner's other than the contested one.
 */
export function winnerNameOf(c: ContestSummary, facts: DirectoryFacts): string | undefined {
  const id = loaded(facts, c.keyString)?.winner?.identityId;
  if (!id) return undefined;
  const names = facts.identityNames[id];
  return kindIdOf(c) === 'dpns' ? otherName(names, dpnsLabel(c.key)) : names?.[0];
}

/**
 * A row's accessible name, e.g. "000.dash — decided Mar 7, 2025, awarded to
 * alice, only contender, 0 votes" or "bob.dash — open, closes in 2h 5m, 12
 * votes".
 */
export function rowLabel(args: {
  title: string;
  open: boolean;
  closes?: string;
  state?: RowState;
  winnerName?: string;
}): string {
  const { title, open, closes, state, winnerName } = args;
  const parts: string[] = [];
  if (open) {
    parts.push(closes ? `open, closes in ${closes}` : 'open');
  } else if (typeof state === 'object') {
    const o = outcomeOf(state);
    if (o.decidedAtMs) parts.push(`decided ${shortDate(o.decidedAtMs)}`);
    if (o.kind === 'awarded') parts.push(winnerName ? `awarded to ${winnerName}` : 'awarded');
    else if (o.kind === 'awaiting') parts.push('ended, awaiting the result');
    else parts.push(o.kind);
    if (o.unopposed) parts.push('only contender');
    else if (o.score) parts.push(o.score.replace('–', ' to '));
  } else {
    parts.push(state === 'error' ? 'ended, result could not be read' : 'ended');
  }
  if (typeof state === 'object') {
    parts.push(`${state.tally.total} vote${state.tally.total === 1 ? '' : 's'}`);
  }
  return `${title} — ${parts.join(', ')}`;
}

/** What one contest of a kind is called in a sentence. */
export const NOUN: Record<KindId, string> = {
  dpns: 'username contest',
  charter: 'moderator election',
  generic: 'other contest',
};

/** "1,036 username contests", "5 moderator elections". */
function kindCount(kind: KindId, n: number): string {
  return `${fmt(n)} ${NOUN[kind]}${n === 1 ? '' : 's'}`;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "1,036 username contests and 5 moderator elections" for some decided rows, in tab order. */
export function decidedWords(rows: readonly ContestSummary[], kinds: readonly KindId[]): string {
  const byKind = new Map<KindId, number>();
  for (const c of rows) {
    const k = kindIdOf(c);
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  return joinWords(kinds.filter((k) => byKind.has(k)).map((k) => kindCount(k, byKind.get(k) ?? 0)));
}

/** The directory's status line: a bold lead (a fact) and the rest. */
export interface StatusSentence {
  lead?: string;
  rest?: string;
}

/**
 * What the status line says. Nothing is claimed about open contests until
 * the active polls have been read, however much the cache already shows;
 * and "nothing is open" never when that read failed.
 */
export function statusSentence(s: {
  connected: boolean;
  /** The decided list can be shown (ordered, from this visit or the cache). */
  ready: boolean;
  /** The active-polls read has finished (successfully or not). */
  openRead: boolean;
  /** The active-polls read failed, so open contests may be missing. */
  openFailed: boolean;
  openCount: number;
  endedCount: number;
  /** decidedWords of the decided rows. */
  decided: string;
  /** "2h 5m": when the soonest open contest closes. */
  nextCloses?: string;
  /** What the app is doing while not connected (default "Connecting to Dash Platform…"). */
  connecting?: string;
}): StatusSentence {
  const reading = () => {
    const found = s.openCount + s.endedCount;
    return found > 0 ? `Reading contests from Platform… ${fmt(found)} found so far.` : 'Reading contests from Platform…';
  };
  let decidedPart = '';
  if (!s.ready) decidedPart = 'Reading decided contests…';
  else if (s.decided) decidedPart = `${s.decided} decided so far.`;

  if (!s.openRead) {
    const waiting = s.connected ? 'Checking for open contests…' : (s.connecting ?? 'Connecting to Dash Platform…');
    if (s.ready && s.decided) return { rest: `${decidedPart} ${waiting}` };
    if (s.connected && !s.ready) return { rest: reading() };
    return { rest: waiting };
  }
  if (s.openCount > 0) {
    const next = s.nextCloses ? `The next closes in ${s.nextCloses}.` : '';
    return {
      lead: `${plural(s.openCount, 'contest')} open for voting.`,
      rest: [next, decidedPart].filter(Boolean).join(' ') || undefined,
    };
  }
  if (s.openFailed) {
    return { rest: ['Open contests could not be read from Platform.', decidedPart].filter(Boolean).join(' ') };
  }
  if (!s.ready) return { rest: reading() };
  if (s.endedCount > 0) {
    return {
      lead: 'Nothing is open for voting right now.',
      rest: `${s.decided} ${s.endedCount === 1 ? 'has' : 'have'} been decided.`,
    };
  }
  return {};
}

/**
 * What an empty tab says, or undefined while it cannot be known to be
 * empty (Platform not connected, open contests not read, lists still
 * streaming): the page keeps its loading rows instead.
 */
export function emptyMessage(s: {
  filter: string;
  connected: boolean;
  /** The active-polls read has finished (successfully or not). */
  openRead: boolean;
  status: StreamStatus;
  failures: number;
  kindFilter?: KindId;
  heading?: string;
  network: Network;
}): string | undefined {
  const typed = s.filter.trim();
  if (typed) return `No contests match “${typed}”.`;
  if (!s.connected || !s.openRead || s.status === 'streaming') return undefined;
  if (s.status === 'error') return 'Contests could not be read from Platform. Check your connection and reload the page.';
  if (s.failures > 0) return 'None found, but some reads failed (see above).';
  if (s.kindFilter === 'generic') {
    return `No other contract has a contested resource on ${s.network} yet. Browse a contract by id to see its contested indices.`;
  }
  if (s.kindFilter) return `No ${s.heading?.toLowerCase() ?? 'contests'} on ${s.network} yet.`;
  return `Nothing is contested on ${s.network} right now.`;
}
