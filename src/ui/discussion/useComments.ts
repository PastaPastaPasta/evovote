import { useCallback, useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { fetchCommentsByScope, type Comment, type CommentOrder, type CommentPage } from '../../discussion/reads';
import type { Scope } from '../../discussion/scope';
import { errorMessage } from '../../sdk/errors';

export interface CommentsState {
  comments: Comment[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** Documents read but not shown (malformed, or naming another contest). */
  hidden: number;
  loadMore: () => void;
  reload: () => void;
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

/**
 * A contest's comments (by its `scope`) in one order, paged with
 * `startAfter`. Changing the scope, the order or calling `reload` starts
 * again from the first page; a response for an earlier query is dropped.
 */
export function useComments(sdk: EvoSDK, contractId: string, scope: Scope, order: CommentOrder): CommentsState {
  const [round, setRound] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const [morePending, setMorePending] = useState(false);
  const queryId = `${contractId}|${scope.scope}|${order}|${round}`;

  useEffect(() => {
    let cancelled = false;
    fetchCommentsByScope(sdk, contractId, scope, { order }).then(
      (page: CommentPage) => {
        if (cancelled) return;
        setLoaded({ queryId, comments: page.comments, hasMore: page.hasMore, hidden: page.hidden, cursor: page.cursor, error: null });
      },
      (e: unknown) => {
        if (cancelled) return;
        setLoaded({ queryId, comments: [], hasMore: false, hidden: 0, error: errorMessage(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, contractId, scope, order, queryId]);

  const here = loaded?.queryId === queryId ? loaded : undefined;

  const loadMore = useCallback(() => {
    if (!here?.cursor || morePending) return;
    const { cursor } = here;
    const asked = queryId;
    setMorePending(true);
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
      .finally(() => setMorePending(false));
  }, [here, morePending, queryId, sdk, contractId, scope, order]);

  const reload = useCallback(() => setRound((n) => n + 1), []);

  return {
    comments: here?.comments ?? [],
    loading: !here || morePending,
    error: here?.error ?? null,
    hasMore: here?.hasMore ?? false,
    hidden: here?.hidden ?? 0,
    loadMore,
    reload,
  };
}
