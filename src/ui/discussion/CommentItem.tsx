import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Comment } from '../../discussion/reads';
import { hueIndex, initialOf, relativeTime } from '../../discussion/present';
import { displayText } from '../../discussion/text';
import { deadlineText, shortId } from '../format';

export const commentAnchor = (id: string): string => `comment-${id}`;

/** A contender of the contest as the discussion shows it. */
export interface ContenderInfo {
  id: string;
  /** DPNS name; absent when the identity has none. */
  name?: string;
  /** Its ballot colour on the page. */
  color: string;
  winner: boolean;
}

/** Avatar tints for people who are not contenders (no purples). */
const AVATAR_TINTS = ['#4e6472', '#0b6eae', '#1b7a46', '#b45309', '#0f766e', '#475569'];

/** A person as a name (DPNS) or, failing that, a short id. Text only. */
export function PersonName({ id, name }: { id: string; name?: string }) {
  return (
    <span className="identity-name" title={id}>
      {name ? <strong>{name}</strong> : <span className="mono">{shortId(id, 6)}</span>}
    </span>
  );
}

/** An initial on a tint; a contender's carries a ring in their ballot colour. */
function Avatar({ id, name, ring }: { id: string; name?: string; ring?: string }) {
  const style: CSSProperties = { backgroundColor: AVATAR_TINTS[hueIndex(id, AVATAR_TINTS.length)] };
  if (ring) style.boxShadow = `0 0 0 2px var(--surface), 0 0 0 4px ${ring}`;
  return (
    <span className="comment-avatar" style={style} aria-hidden="true">
      {initialOf(name ?? id)}
    </span>
  );
}

function Time({ ms, now }: { ms: number; now: number }) {
  const when = new Date(ms);
  if (!Number.isFinite(when.getTime()) || ms <= 0) return null;
  return (
    <time dateTime={when.toISOString()} title={deadlineText(ms, now)}>
      {relativeTime(ms, now)}
    </time>
  );
}

/**
 * One comment card. Everything from Platform (the body, names, ids) is
 * rendered as React text, never as HTML.
 */
export function CommentItem({
  comment,
  names,
  contenders,
  now,
  replyTarget,
  orphan = false,
  highlighted = false,
  onReply,
  onCopyLink,
  children,
}: {
  comment: Comment;
  names: ReadonlyMap<string, string>;
  /** The contest's contenders by identity. */
  contenders: ReadonlyMap<string, ContenderInfo>;
  /** The time relative times are measured from. */
  now: number;
  /** Set for a reply to a reply: the comment it answers, shown as "to <name>". */
  replyTarget?: Comment;
  /** It answers a comment that is not on screen. */
  orphan?: boolean;
  highlighted?: boolean;
  onReply?: () => void;
  /** Copies a link to this comment; resolves to whether it worked. */
  onCopyLink?: () => Promise<boolean>;
  /** Replies and the inline reply box, under the card. */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const author = contenders.get(comment.ownerId);
  const authorName = names.get(comment.ownerId);
  const backed = comment.supports && comment.supports !== comment.ownerId ? comment.supports : undefined;
  const backedContender = backed ? contenders.get(backed) : undefined;

  const copy = async () => {
    if (!onCopyLink) return;
    setCopied((await onCopyLink()) ? 'yes' : 'no');
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <li className={highlighted ? 'comment highlighted' : 'comment'} id={commentAnchor(comment.id)}>
      <div className="comment-card">
        <Avatar id={comment.ownerId} name={authorName} ring={author?.color} />
        <div className="comment-main">
          <div className="comment-head">
            <PersonName id={comment.ownerId} name={authorName} />
            {author &&
              (author.winner ? (
                <span className="badge winner" title="This author won this contest">
                  Winner
                </span>
              ) : (
                <span
                  className="badge candidate"
                  style={{ '--badge-color': author.color } as CSSProperties}
                  title="This author is a contender in this contest"
                >
                  Candidate
                </span>
              ))}
            {backed &&
              (backedContender ? (
                <span className="comment-backs">
                  <span className="dot" style={{ backgroundColor: backedContender.color }} aria-hidden="true" />
                  backs <PersonName id={backed} name={names.get(backed)} />
                </span>
              ) : (
                // The field is the author's claim: only a contender of this contest is named.
                <span className="comment-backs">backs someone who is not in this contest</span>
              ))}
            <Time ms={comment.createdAtMs} now={now} />
          </div>
          {replyTarget && (
            <p className="comment-context">
              ↳ to <PersonName id={replyTarget.ownerId} name={names.get(replyTarget.ownerId)} />
            </p>
          )}
          {orphan && <p className="comment-context">Reply to an earlier comment that is not shown here</p>}
          <p className="comment-body">{displayText(comment.body)}</p>
          {(onReply || onCopyLink) && (
            <div className="comment-actions">
              {onReply && (
                <button type="button" className="text-action" onClick={onReply}>
                  Reply
                </button>
              )}
              {onCopyLink && (
                <button type="button" className="text-action" onClick={() => void copy()} aria-live="polite">
                  {copied === 'yes' ? 'Link copied' : copied === 'no' ? 'Could not copy' : 'Copy link'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {children}
    </li>
  );
}
