import type { Comment } from './reads';

/**
 * Pure presentation helpers for a discussion: threading, relative times and
 * how a read error is worded. No React, no SDK.
 */

/** A top-level comment with its replies (one level: replies to replies join their root). */
export interface Thread {
  root: Comment;
  /** Oldest first. */
  replies: Comment[];
  /** True when the root answers a comment that is not loaded (an earlier page, or gone). */
  orphan: boolean;
}

/** How far up a reply chain is followed (a malformed chain cannot loop forever). */
const MAX_DEPTH = 50;

/**
 * Group comments into one-level threads. Roots keep the order they came in
 * (the chosen sort); a reply to a reply sits under the thread's root, in
 * time order. A reply whose parent is not loaded is shown as a root.
 */
export function buildThreads(comments: readonly Comment[]): Thread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  // A chain that loops (impossible for real document ids, but the reader
  // must not lose comments over it) leaves the comment as its own root.
  const rootOf = (c: Comment): Comment => {
    const seen = new Set([c.id]);
    let current = c;
    for (let depth = 0; depth < MAX_DEPTH && current.replyTo; depth++) {
      const parent = byId.get(current.replyTo);
      if (!parent) break;
      if (seen.has(parent.id)) return c;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  // A Map iterates in insertion order, so the threads keep the roots' order.
  const threads = new Map<string, Thread>();
  for (const c of comments) {
    if (rootOf(c).id === c.id && !threads.has(c.id)) {
      threads.set(c.id, { root: c, replies: [], orphan: c.replyTo !== undefined });
    }
  }
  for (const c of comments) {
    const root = rootOf(c);
    if (root.id !== c.id) threads.get(root.id)?.replies.push(c);
  }
  for (const t of threads.values()) t.replies.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return [...threads.values()];
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Whether a read failed because the node is busy (worth retrying shortly). */
export function isBusyError(message: string): boolean {
  return /rate.?limit|too many requests|resource.?exhausted|\b429\b|unavailable|overload|timed? ?out|deadline/i.test(message);
}

/** The first letter or digit of a name, for an avatar. */
export function initialOf(label: string): string {
  const match = label.match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? '?').toUpperCase();
}

/** A stable small number from an id, to pick an avatar tint. */
export function hueIndex(id: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % buckets;
}

/** The comment a shared link points at (`?c=<id>` before the hash route). */
export function linkedCommentId(search: string): string | undefined {
  const id = new URLSearchParams(search).get('c');
  return id && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id) ? id : undefined;
}

/** A link to one comment: the page as it is, with `?c=<id>` before the hash. */
export function commentLink(loc: { origin: string; pathname: string; hash: string }, id: string): string {
  return `${loc.origin}${loc.pathname}?c=${id}${loc.hash}`;
}
