import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { discussionContractId } from '../../discussion/config';
import { resolveNames } from '../../discussion/names';
import { buildThreads, commentLink, isBusyError, linkedCommentId, type Thread } from '../../discussion/present';
import type { Comment, CommentOrder } from '../../discussion/reads';
import { scopeOf, type Scope } from '../../discussion/scope';
import { encodePollKey, type PollKey } from '../../model/pollKey';
import type { SdkHandle } from '../../sdk/connection';
import type { Network } from '../../sdk/network';
import { useIdentitySession } from '../../identity/session';
import { useNow } from '../hooks';
import { useAsync } from '../useAsync';
import { endDate } from '../format';
import { commentAnchor, CommentItem, type ContenderInfo } from './CommentItem';
import { Composer } from './Composer';
import { useComments } from './useComments';

export type { ContenderInfo } from './CommentItem';

/** How a decided contest ended, for the note above its discussion. */
export interface ContestOutcome {
  decidedAtMs?: number;
  /** The winner's label; absent when it was locked. */
  winnerName?: string;
}

/** Replies shown under a comment before "Show N more replies". */
const REPLIES_SHOWN = 3;
/** The sort control appears once a discussion is this long. */
const SORT_FROM = 5;

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

/** Names for a set of identities; grows as pages load. */
function useNames(handle: SdkHandle, ids: readonly string[]): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(EMPTY_NAMES);
  const wanted = useMemo(() => [...new Set(ids)].sort().join(','), [ids]);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void resolveNames(handle.sdk, wanted.split(',')).then((found) => {
      if (!cancelled) setNames((prev) => new Map([...prev, ...found]));
    });
    return () => {
      cancelled = true;
    };
  }, [handle, wanted]);
  return names;
}

function Band({
  count,
  tools,
  children,
}: {
  /** "3", "30+", or undefined while unknown. */
  count?: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="discussion-band" id="discussion" aria-labelledby="discussion-title">
      <header className="discussion-band-head">
        <div>
          <h2 id="discussion-title">
            Discussion{count !== undefined && count !== '0' && <span className="discussion-count"> · {count}</span>}
          </h2>
          <p className="discussion-sub">Public and permanent. Comments don't count as votes.</p>
        </div>
        {tools}
      </header>
      {children}
    </section>
  );
}

/**
 * The discussion of one contest (any kind), on the discussion contract of the
 * network. With no contract configured it says so and does nothing else.
 */
export function Discussion({
  handle,
  network,
  pollKey,
  contenders,
  outcome,
  onCount,
}: {
  handle: SdkHandle;
  network: Network;
  pollKey: PollKey;
  /** The contest's contenders (a charter's are its leaders). */
  contenders: readonly ContenderInfo[];
  /** Set once the contest is decided. */
  outcome?: ContestOutcome;
  /** Reports the number of comments loaded, and whether there are more. */
  onCount?: (count: number, more: boolean) => void;
}) {
  const contractId = discussionContractId(network);
  if (!contractId) {
    return (
      <Band>
        <p className="discussion-empty">Discussion is not activated on {network}.</p>
      </Band>
    );
  }
  return (
    <ActiveDiscussion
      handle={handle}
      contractId={contractId}
      pollKey={pollKey}
      contenders={contenders}
      outcome={outcome}
      onCount={onCount}
    />
  );
}

function ActiveDiscussion({
  handle,
  contractId,
  pollKey,
  contenders,
  outcome,
  onCount,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  contenders: readonly ContenderInfo[];
  outcome?: ContestOutcome;
  onCount?: (count: number, more: boolean) => void;
}) {
  const keyString = encodePollKey(pollKey);
  const scope = useAsync(() => scopeOf(pollKey), [keyString]);
  if (scope.status === 'loading') {
    return (
      <Band>
        <p className="discussion-loading" role="status">
          Loading comments…
        </p>
      </Band>
    );
  }
  if (scope.status === 'error') {
    return (
      <Band>
        <p className="discussion-empty">Discussion is unavailable for this contest: {scope.message}</p>
      </Band>
    );
  }
  return (
    <ThreadView
      handle={handle}
      contractId={contractId}
      pollKey={pollKey}
      scope={scope.value}
      contenders={contenders}
      outcome={outcome}
      onCount={onCount}
    />
  );
}

/** A read failure in plain words, the raw text behind "Technical detail". */
function ReadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="discussion-alert" role="alert">
      <p>
        {isBusyError(error)
          ? 'Platform is busy right now, so the comments could not be loaded.'
          : 'The comments could not be loaded.'}{' '}
        <button type="button" className="text-action" onClick={onRetry}>
          Try again
        </button>
      </p>
      <details>
        <summary>Technical detail</summary>
        <p className="mono">{error}</p>
      </details>
    </div>
  );
}

function ThreadView({
  handle,
  contractId,
  pollKey,
  scope,
  contenders,
  outcome,
  onCount,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  scope: Scope;
  contenders: readonly ContenderInfo[];
  outcome?: ContestOutcome;
  onCount?: (count: number, more: boolean) => void;
}) {
  const session = useIdentitySession();
  const now = useNow(60_000);
  const [order, setOrder] = useState<CommentOrder>('oldest');
  const [replyingTo, setReplyingTo] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [linked] = useState(() => linkedCommentId(location.search));
  // The comment just posted: its thread opens in full so it is seen.
  const [justPosted, setJustPosted] = useState<string>();
  // An inline reply is being signed and sent: Reply buttons wait, so the box
  // (and the outcome it will show) is not swapped out mid-post.
  const [replyBusy, setReplyBusy] = useState(false);
  const scrolledTo = useRef<string | undefined>(undefined);
  const { comments, loading, error, retrying, hasMore, hidden, fresh, loadMore, reload, addLocal } = useComments(
    handle.sdk,
    contractId,
    scope,
    order,
  );

  const nameIds = useMemo(
    () => comments.flatMap((c) => (c.supports ? [c.ownerId, c.supports] : [c.ownerId])),
    [comments],
  );
  const looked = useNames(handle, nameIds);
  // The page's labels for contenders win, so one person reads the same everywhere.
  const names = useMemo(() => {
    const merged = new Map(looked);
    for (const c of contenders) {
      if (c.name) merged.set(c.id, c.name);
      else merged.delete(c.id);
    }
    return merged;
  }, [looked, contenders]);
  const contenderMap = useMemo(() => new Map(contenders.map((c) => [c.id, c])), [contenders]);
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const threads = useMemo(() => buildThreads(comments), [comments]);
  const settled = !loading && !error;

  useEffect(() => {
    if (settled) onCount?.(comments.length, hasMore);
  }, [settled, comments.length, hasMore, onCount]);

  // A shared link (`?c=<id>`): scroll to the comment and mark it, once loaded.
  useEffect(() => {
    if (!linked || scrolledTo.current === linked || !byId.has(linked)) return;
    scrolledTo.current = linked;
    requestAnimationFrame(() =>
      document.getElementById(commentAnchor(linked))?.scrollIntoView({ block: 'center' }),
    );
    // Drop the parameter so later navigation does not carry it.
    history.replaceState(null, '', location.pathname + location.hash);
  }, [linked, byId]);

  const copyLink = (id: string) => async () => {
    try {
      await navigator.clipboard.writeText(commentLink(location, id));
      return true;
    } catch {
      return false;
    }
  };

  const posted = (comment?: Comment) => {
    // A pending post (accepted, not read back yet) keeps its box open with
    // its "do not post again" note; a confirmed reply closes only its own box.
    if (!comment) {
      reload();
      return;
    }
    setReplyingTo((current) => (current !== undefined && current === comment.replyTo ? undefined : current));
    setJustPosted(comment.id);
    // Oldest first with more pages: the new comment belongs after pages not
    // loaded yet, so show the newest instead of inserting it out of order.
    if (order === 'oldest' && hasMore) setOrder('newest');
    else addLocal(comment);
  };

  const composerProps = { handle, contractId, pollKey, scope, contenders, decided: outcome !== undefined, names };

  const renderComment = (comment: Comment, thread: Thread, isReply: boolean, children?: ReactNode) => {
    const parent = isReply && comment.replyTo !== thread.root.id ? byId.get(comment.replyTo ?? '') : undefined;
    return (
      <CommentItem
        key={comment.id}
        comment={comment}
        names={names}
        contenders={contenderMap}
        now={now}
        replyTarget={parent}
        orphan={!isReply && thread.orphan}
        highlighted={comment.id === linked}
        onReply={replyBusy ? undefined : () => setReplyingTo((current) => (current === comment.id ? undefined : comment.id))}
        onCopyLink={copyLink(comment.id)}
      >
        {replyingTo === comment.id && (
          <div className="inline-reply">
            <Composer
              {...composerProps}
              replyTo={comment}
              onCancel={() => setReplyingTo(undefined)}
              onPosted={posted}
              onBusyChange={setReplyBusy}
            />
          </div>
        )}
        {children}
      </CommentItem>
    );
  };

  const count = settled || comments.length > 0 ? `${comments.length}${hasMore ? '+' : ''}` : undefined;
  const showSort = comments.length >= SORT_FROM || hasMore;

  return (
    <Band
      count={count}
      tools={
        showSort && (
          <label className="discussion-sort">
            <span>Sort</span>
            <select value={order} onChange={(e) => setOrder(e.target.value as CommentOrder)}>
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select>
          </label>
        )
      }
    >
      {outcome && (
        <p className="discussion-closed">
          Voting closed{outcome.decidedAtMs ? ` ${endDate(outcome.decidedAtMs)}` : ''} ·{' '}
          {outcome.winnerName ? `${outcome.winnerName} won` : 'locked, nobody won'}. Comments stay open.
        </p>
      )}
      {fresh > 0 && (
        <div role="status">
          <button
            type="button"
            className="fresh-pill"
            // Oldest first with more pages: the new ones are at the far end.
            onClick={() => (order === 'oldest' && hasMore ? setOrder('newest') : reload())}
          >
            {fresh === 1 ? '1 new comment' : `${fresh} new comments`} · show
          </button>
        </div>
      )}
      {error && <ReadError error={error} onRetry={reload} />}
      {linked && settled && !byId.has(linked) && (
        <p className="discussion-closed" role="status">
          {hasMore
            ? 'The linked comment is further down: load more comments to find it.'
            : 'The linked comment is not in this discussion.'}
        </p>
      )}
      {retrying > 0 && (
        <p className="discussion-loading" role="status">
          Platform is busy; trying again ({retrying} of 3)…
        </p>
      )}
      {!loading && !error && comments.length === 0 && !hasMore && (
        <div className="discussion-empty">
          <strong>No comments yet.</strong>
          <span>
            {outcome
              ? 'Share what you think of the result, or ask the winner what comes next.'
              : 'Say who you back and why, or ask the contenders a question.'}
          </span>
        </div>
      )}
      {comments.length > 0 && (
        <ol className="thread-list">
          {threads.map((thread) => {
            // A thread holding the linked comment opens in full, so the link lands.
            const open =
              expanded.has(thread.root.id) || thread.replies.some((r) => r.id === linked || r.id === justPosted);
            const shown = open ? thread.replies : thread.replies.slice(0, REPLIES_SHOWN);
            const more = thread.replies.length - shown.length;
            return renderComment(
              thread.root,
              thread,
              false,
              thread.replies.length > 0 && (
                <ol className="reply-list">
                  {shown.map((r) => renderComment(r, thread, true))}
                  {more > 0 && (
                    <li className="reply-more">
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => setExpanded((prev) => new Set([...prev, thread.root.id]))}
                      >
                        Show {more} more {more === 1 ? 'reply' : 'replies'}
                      </button>
                    </li>
                  )}
                </ol>
              ),
            );
          })}
        </ol>
      )}
      {loading && retrying === 0 && (
        <p className="discussion-loading" role="status">
          Loading comments…
        </p>
      )}
      {hasMore && !loading && (
        <button type="button" className="vote-button ghost load-more" onClick={loadMore}>
          Load more comments
        </button>
      )}
      {hidden > 0 && (
        <p className="discussion-hidden">
          {hidden} document{hidden === 1 ? '' : 's'} in this discussion could not be shown (malformed or not
          belonging to this contest).
        </p>
      )}
      <div className="discussion-compose-slot">
        {session || !replyingTo ? <Composer {...composerProps} onPosted={posted} /> : null}
      </div>
    </Band>
  );
}
