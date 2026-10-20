import { useCallback, useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { isBusyError } from '../../discussion/present';
import { fetchCommentsByScope, type Comment, type CommentOrder } from '../../discussion/reads';
import type { Scope } from '../../discussion/scope';
import { errorMessage } from '../../sdk/errors';

interface CommentsState {
  comments: Comment[];
  loading: boolean;
  /** The last read failed (after its automatic retries). */
  error: string | null;
  /** A busy node is being retried; the attempt number. */
  retrying: number;
  hasMore: boolean;
  /** Documents read but not shown (malformed, or naming another contest). */
  hidden: number;
  /** Comments posted since this list was read (found by the background check). */
  fresh: number;
  loadMore: () => void;
  reload: () => void;
  /** Show a comment just posted (already read back) without a re-read. */
  addLocal: (comment: Comment) => void;
}

interface Loaded {
  /** The query this result answers; a result for another query is never shown. */
  queryId: string;
  comments: Comment[];
  hasMore: boolean;
  hidden: number;
  cursor?: string;
  error: string | null;
}

/** Pauses before retrying a busy node: three tries, then the reader decides. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
/** How often an open discussion checks for new comments. */
const FRESH_CHECK_MS = 60_000;
const FRESH_PAGE = 10;

/**
 * A contest's comments (by its `scope`) in one order, paged with
 * `startAfter`. Changing the scope, the order or calling `reload` starts
 * again from the first page; a response for an earlier query is dropped.
 * A busy node is retried with backoff before an error is shown, and while
 * the page is visible the newest comments are re-read in the background to
 * offer "N new comments".
 */
export function useComments(sdk: EvoSDK, contractId: string, scope: Scope, order: CommentOrder): CommentsState {
  const [round, setRound] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const [retrying, setRetrying] = useState<{ queryId: string; attempt: number } | null>(null);
  const [morePendingFor, setMorePendingFor] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ queryId: string; ids: string[] } | null>(null);
  const queryId = `${contractId}|${scope.scope}|${order}|${round}`;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      fetchCommentsByScope(sdk, contractId, scope, { order }).then(
        (page) => {
          if (cancelled) return;
          setRetrying(null);
          setLoaded({ queryId, comments: page.comments, hasMore: page.hasMore, hidden: page.hidden, cursor: page.cursor, error: null });
        },
        (e: unknown) => {
          if (cancelled) return;
          const message = errorMessage(e);
          if (isBusyError(message) && n < RETRY_DELAYS_MS.length) {
            setRetrying({ queryId, attempt: n + 1 });
            timer = setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n]);
            return;
          }
          setRetrying(null);
          setLoaded({ queryId, comments: [], hasMore: false, hidden: 0, error: message });
        },
      );
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sdk, contractId, scope, order, queryId]);

  const here = loaded?.queryId === queryId ? loaded : undefined;
  const morePending = morePendingFor === queryId;

  // Background check for comments posted since the list was read. Quiet: a
  // failed check is simply tried again on the next tick.
  const knownIds = here && !here.error ? here.comments.map((c) => c.id).join(',') : undefined;
  useEffect(() => {
    if (knownIds === undefined) return;
    const known = new Set(knownIds ? knownIds.split(',') : []);
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      fetchCommentsByScope(sdk, contractId, scope, { order: 'newest', pageSize: FRESH_PAGE })
        .then((page) => {
          if (cancelled) return;
          const ids = page.comments.filter((c) => !known.has(c.id)).map((c) => c.id);
          setFresh({ queryId, ids });
        })
        .catch(() => undefined);
    };
    const timer = setInterval(check, FRESH_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sdk, contractId, scope, queryId, knownIds]);

  const loadMore = useCallback(() => {
    if (!here?.cursor || morePending) return;
    const { cursor } = here;
    const asked = queryId;
    setMorePendingFor(asked);
    fetchCommentsByScope(sdk, contractId, scope, { order, startAfter: cursor })
      .then((page) => {
        setLoaded((prev) => {
          if (!prev || prev.queryId !== asked) return prev;
          const seen = new Set(prev.comments.map((c) => c.id));
          return {
            ...prev,
            comments: [...prev.comments, ...page.comments.filter((c) => !seen.has(c.id))],
            hasMore: page.hasMore,
            hidden: prev.hidden + page.hidden,
            cursor: page.cursor,
            error: null,
          };
        });
      })
      .catch((e: unknown) => {
        setLoaded((prev) => (prev && prev.queryId === asked ? { ...prev, error: errorMessage(e) } : prev));
      })
      .finally(() => setMorePendingFor((current) => (current === asked ? null : current)));
  }, [here, morePending, queryId, sdk, contractId, scope, order]);

  const reload = useCallback(() => setRound((n) => n + 1), []);

  const addLocal = useCallback(
    (comment: Comment) => {
      setLoaded((prev) => {
        if (!prev || prev.queryId !== queryId || prev.comments.some((c) => c.id === comment.id)) return prev;
        return {
          ...prev,
          comments: order === 'newest' ? [comment, ...prev.comments] : [...prev.comments, comment],
        };
      });
    },
    [queryId, order],
  );

  const freshHere = fresh?.queryId === queryId ? fresh.ids.filter((id) => !here?.comments.some((c) => c.id === id)) : [];

  return {
    comments: here?.comments ?? [],
    loading: !here || morePending,
    error: here?.error ?? null,
    retrying: retrying?.queryId === queryId ? retrying.attempt : 0,
    hasMore: here?.hasMore ?? false,
    hidden: here?.hidden ?? 0,
    fresh: freshHere.length,
    loadMore,
    reload,
    addLocal,
  };
}
