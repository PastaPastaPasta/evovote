import { useEffect, useMemo, useState } from 'react';
import { discussionContractId } from '../../discussion/config';
import { resolveNames } from '../../discussion/names';
import type { Comment, CommentOrder } from '../../discussion/reads';
import { scopeOf, type Scope } from '../../discussion/scope';
import { encodePollKey, type PollKey } from '../../model/pollKey';
import type { SdkHandle } from '../../sdk/connection';
import type { Network } from '../../sdk/network';
import { useIdentitySession } from '../../identity/session';
import { useAsync } from '../useAsync';
import { CommentItem } from './CommentItem';
import { Composer } from './Composer';
import { useComments } from './useComments';

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

function Section({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="discussion" aria-labelledby="discussion-title">
      <div className="discussion-heading">
        <div>
          <span className="mono-label">Community</span>
          <h2 id="discussion-title">Discussion</h2>
        </div>
        {actions}
      </div>
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
}: {
  handle: SdkHandle;
  network: Network;
  pollKey: PollKey;
  /** The contest's contender identities (a charter's are its leaders). */
  contenders: readonly string[];
}) {
  const contractId = discussionContractId(network);
  if (!contractId) {
    return (
      <Section>
        <p className="page-note">Discussion is not activated on {network}.</p>
      </Section>
    );
  }
  return <ActiveDiscussion handle={handle} contractId={contractId} pollKey={pollKey} contenders={contenders} />;
}

function ActiveDiscussion({
  handle,
  contractId,
  pollKey,
  contenders,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  contenders: readonly string[];
}) {
  const keyString = encodePollKey(pollKey);
  const scope = useAsync(() => scopeOf(pollKey), [keyString]);
  if (scope.status === 'loading') return <Section>{null}</Section>;
  if (scope.status === 'error') {
    return (
      <Section>
        <p className="page-note error">Discussion is unavailable for this contest: {scope.message}</p>
      </Section>
    );
  }
  return (
    <Thread
      handle={handle}
      contractId={contractId}
      pollKey={pollKey}
      scope={scope.value}
      contenders={contenders}
    />
  );
}

function Thread({
  handle,
  contractId,
  pollKey,
  scope,
  contenders,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  scope: Scope;
  contenders: readonly string[];
}) {
  const session = useIdentitySession();
  const [order, setOrder] = useState<CommentOrder>('newest');
  const [replyingTo, setReplyingTo] = useState<Comment>();
  const { comments, loading, error, hasMore, hidden, loadMore, reload } = useComments(handle.sdk, contractId, scope, order);

  const nameIds = useMemo(
    () => [...comments.flatMap((c) => (c.supports ? [c.ownerId, c.supports] : [c.ownerId])), ...contenders],
    [comments, contenders],
  );
  const names = useNames(handle, nameIds);
  const contenderIds = useMemo(() => new Set(contenders), [contenders]);
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);

  return (
    <Section
      actions={
        <div className="discussion-actions">
          <div className="segmented" role="group" aria-label="Order">
            {(['newest', 'oldest'] as const).map((o) => (
              <button
                key={o}
                type="button"
                className="link-button"
                aria-pressed={order === o}
                onClick={() => setOrder(o)}
              >
                {o === 'newest' ? 'Newest first' : 'Oldest first'}
              </button>
            ))}
          </div>
          <button className="link-button" disabled={loading} onClick={reload}>
            Refresh
          </button>
        </div>
      }
    >
      <Composer
        handle={handle}
        contractId={contractId}
        pollKey={pollKey}
        scope={scope}
        contenders={contenders}
        names={names}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(undefined)}
        onPosted={() => {
          if (order === 'newest') reload();
          else setOrder('newest');
        }}
      />
      {error && <p className="page-note error" role="alert">Could not load comments: {error}</p>}
      {!loading && !error && comments.length === 0 && !hasMore && (
        <p className="page-note">No comments yet. Start the conversation.</p>
      )}
      <ol className="comment-list">
        {comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            names={names}
            contenderIds={contenderIds}
            replyTarget={comment.replyTo ? byId.get(comment.replyTo) : undefined}
            onReply={
              session
                ? () => {
                    setReplyingTo(comment);
                    document.getElementById('comment-body')?.focus();
                  }
                : undefined
            }
          />
        ))}
      </ol>
      {hidden > 0 && (
        <p className="fine-print">
          {hidden} document{hidden === 1 ? '' : 's'} in this discussion could not be shown (malformed or not
          belonging to this contest).
        </p>
      )}
      {loading && <p className="mono-label" role="status">Loading comments…</p>}
      {hasMore && !loading && (
        <button className="vote-button ghost" onClick={loadMore}>
          Load more comments
        </button>
      )}
    </Section>
  );
}
