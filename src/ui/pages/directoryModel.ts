import { dpnsLabel, normalizeDpnsLabel, type DpnsName } from '../../kinds/dpns';
import type { ContestKind } from '../../kinds/types';
import type { Contest, ContestSummary } from '../../model/contest';

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

/** The loaded contest of a row, if any. */
export function loaded(facts: DirectoryFacts, keyString: string): Contest | undefined {
  const s = facts.states[keyString];
  return typeof s === 'object' ? s : undefined;
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
    if (ra === undefined || rb === undefined) {
      return ra === rb ? byName(a, b) : ra === undefined ? 1 : -1;
    }
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
  const lower = raw.toLowerCase();
  const bare = lower.endsWith('.dash') ? lower.slice(0, -'.dash'.length) : lower;
  return { raw, lower: bare, normalized: normalizeDpnsLabel(bare) };
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
  const title = kind.title(state ?? c).toLowerCase().replace(/\.dash$/, '');
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
    if (names.some((n) => normalizeDpnsLabel(n.replace(/\.dash$/i, '')).includes(needle.normalized))) return true;
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
export function otherName(names: readonly string[] | undefined, normalized?: string): string | undefined {
  return names?.find((n) => normalizeDpnsLabel(n.replace(/\.dash$/i, '')) !== normalized);
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
