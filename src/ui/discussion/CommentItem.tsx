import type { Comment } from '../../discussion/reads';
import { displayText } from '../../discussion/text';
import { shortId } from '../format';

const commentAnchor = (id: string): string => `comment-${id}`;

/** A person as a name (DPNS) or, failing that, a short id. Text only. */
export function PersonName({ id, name }: { id: string; name?: string }) {
  return (
    <span className="identity-name" title={id}>
      {name ? <strong>{name}</strong> : <span className="mono">{shortId(id, 6)}</span>}
    </span>
  );
}

/**
 * One comment. Everything from Platform (the body, names, ids) is rendered
 * as React text, never as HTML.
 */
export function CommentItem({
  comment,
  names,
  contenderIds,
  replyTarget,
  onReply,
}: {
  comment: Comment;
  names: ReadonlyMap<string, string>;
  contenderIds: ReadonlySet<string>;
  /** The comment this answers, when it is on screen. */
  replyTarget?: Comment;
  /** Absent when the reader cannot reply (not signed in). */
  onReply?: () => void;
}) {
  const when = new Date(comment.createdAtMs);
  const timeValid = Number.isFinite(when.getTime()) && comment.createdAtMs > 0;
  return (
    <li className="comment" id={commentAnchor(comment.id)}>
      <div className="comment-head">
        <PersonName id={comment.ownerId} name={names.get(comment.ownerId)} />
        {contenderIds.has(comment.ownerId) && (
          <span className="chip won" title="This author is a contender in this contest">
            contender
          </span>
        )}
        {comment.supports && (
          <span className="comment-supports">
            {/* The field is the author's claim: only a contender of this contest is named. */}
            {contenderIds.has(comment.supports) ? (
              <>
                supports <PersonName id={comment.supports} name={names.get(comment.supports)} />
              </>
            ) : (
              'supports an identity that is not in this contest'
            )}
          </span>
        )}
        {timeValid && <time dateTime={when.toISOString()}>{when.toLocaleString()}</time>}
      </div>
      {comment.replyTo && (
        <p className="fine-print comment-reply-to">
          {replyTarget ? (
            <>
              In reply to <PersonName id={replyTarget.ownerId} name={names.get(replyTarget.ownerId)} />{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => document.getElementById(commentAnchor(replyTarget.id))?.scrollIntoView({ block: 'center' })}
              >
                (show)
              </button>
            </>
          ) : (
            <>In reply to comment {shortId(comment.replyTo, 6)}</>
          )}
        </p>
      )}
      <p className="comment-body">{displayText(comment.body)}</p>
      {onReply && (
        <button type="button" className="link-button" onClick={onReply}>
          Reply
        </button>
      )}
    </li>
  );
}
