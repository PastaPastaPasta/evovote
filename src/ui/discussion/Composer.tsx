import { useEffect, useId, useRef, useState } from 'react';
import { readBalance } from '../../charters/writes';
import { estimateComment, commentLength, COMMENT_LIMIT, postComment, validateDraft, type CommentDraft } from '../../discussion/writes';
import type { Comment } from '../../discussion/reads';
import { displayText } from '../../discussion/text';
import type { Scope } from '../../discussion/scope';
import type { WriteOutcome } from '../../identity/outcome';
import { documentSigningProblem, refreshIdentity, useIdentitySession, withDocumentSigner } from '../../identity/session';
import { dashText } from '../../model/credits';
import type { PollKey } from '../../model/pollKey';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import { useAsync } from '../useAsync';
import { shortId } from '../format';
import { PersonName, type ContenderInfo } from './CommentItem';
import { SignInPrompt } from './SignInPrompt';

interface Frozen {
  draft: CommentDraft;
  backsLabel?: string;
  backsColor?: string;
}

/**
 * The review step: the comment as it will appear, what it costs against the
 * balance, and that it is permanent. Nothing is signed until "Post comment".
 */
function ReviewCard({
  handle,
  contractId,
  pollKey,
  scope,
  identityId,
  authorName,
  frozen,
  replyToName,
  onBack,
  onDone,
  onBusyChange,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  scope: Scope;
  identityId: string;
  authorName?: string;
  frozen: Frozen;
  replyToName?: string;
  onBack: () => void;
  onDone: (outcome: WriteOutcome<Comment>) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { draft } = frozen;
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The form was replaced: move focus to the card so keyboard users follow.
  useEffect(() => heading.current?.focus(), []);
  const priced = useAsync(
    async () => {
      const [cost, balance] = await Promise.all([
        estimateComment(handle, contractId, scope, draft),
        readBalance(handle.sdk, identityId),
      ]);
      return { cost, balance };
    },
    [handle, contractId, scope, identityId, draft],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const short = priced.status === 'ok' && priced.value.balance < priced.value.cost.total;

  const post = async () => {
    setBusy(true);
    onBusyChange?.(true);
    setFailure(null);
    try {
      const outcome = await withDocumentSigner(handle, contractId, (signer) =>
        postComment(handle, signer, contractId, pollKey, draft),
      );
      await refreshIdentity().catch(() => undefined);
      onBusyChange?.(false);
      onDone(outcome);
    } catch (e) {
      onBusyChange?.(false);
      setFailure(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="review-card" role="group" aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1}>
        Review your {draft.replyTo ? 'reply' : 'comment'}
      </h3>
      <div className="review-preview">
        <div className="comment-head">
          <PersonName id={identityId} name={authorName} />
          {replyToName && <span className="comment-backs">replying to {replyToName}</span>}
          {frozen.backsLabel && (
            <span className="comment-backs">
              <span className="dot" style={{ backgroundColor: frozen.backsColor }} aria-hidden="true" />
              backs {frozen.backsLabel}
            </span>
          )}
        </div>
        <p className="comment-body">{displayText(draft.body)}</p>
      </div>
      <dl className="review-cost">
        <div>
          <dt>Cost</dt>
          <dd>
            {priced.status === 'ok'
              ? `about ${dashText(priced.value.cost.total)}`
              : priced.status === 'loading'
                ? 'Estimating…'
                : 'Could not estimate'}
          </dd>
        </div>
        <div>
          <dt>Your balance</dt>
          <dd>{priced.status === 'ok' ? dashText(priced.value.balance) : priced.status === 'loading' ? 'Reading…' : '—'}</dd>
        </div>
      </dl>
      {priced.status === 'error' && (
        <p className="discussion-alert">
          Could not read the price or your balance.{' '}
          <button type="button" className="text-action" onClick={priced.reload}>
            Try again
          </button>
        </p>
      )}
      {short && <p className="discussion-alert">Your balance does not cover this comment. Top up your identity first.</p>}
      <p className="review-permanence">
        Comments are public and permanent: once posted, this cannot be edited or deleted.
      </p>
      {failure && (
        <div className="discussion-alert">
          <p>It was not posted: signing or sending failed.</p>
          <details>
            <summary>Technical detail</summary>
            <p className="mono">{failure}</p>
          </details>
        </div>
      )}
      <div className="composer-actions">
        <button type="button" className="vote-button ghost" disabled={busy} onClick={onBack}>
          Back to editing
        </button>
        <button
          type="button"
          className="vote-button"
          disabled={busy || priced.status !== 'ok' || short}
          onClick={() => void post()}
        >
          {busy ? 'Posting…' : 'Post comment'}
        </button>
      </div>
    </div>
  );
}

/** What happened to a post, in plain words. A refused or unknown one keeps the draft. */
function OutcomeNote({ outcome }: { outcome: WriteOutcome<Comment> }) {
  if (outcome.status === 'confirmed') return <p className="discussion-ok">Posted. Your comment is on Platform.</p>;
  if (outcome.status === 'pending') {
    return (
      <p className="discussion-ok">
        Posted. It may take a minute to show up for everyone; do not post it again.
      </p>
    );
  }
  if (outcome.status === 'refused') {
    return (
      <div className="discussion-alert">
        <p>Platform refused this comment: {outcome.error.message}</p>
        {outcome.error.detail !== outcome.error.message && (
          <details>
            <summary>Technical detail</summary>
            <p className="mono">{outcome.error.detail}</p>
          </details>
        )}
      </div>
    );
  }
  return (
    <div className="discussion-alert">
      <p>
        No answer from Platform, and the comment could not be found yet. It may still land: wait a minute and
        reload before posting again, or you may pay twice.
      </p>
      {outcome.error && (
        <details>
          <summary>Technical detail</summary>
          <p className="mono">{outcome.error.detail}</p>
        </details>
      )}
    </div>
  );
}

/**
 * The comment box: a new comment at the bottom of the discussion, or an
 * inline reply under a comment. "Review" swaps the form for the review card;
 * a comment is only shown as posted once it has been read back.
 */
export function Composer({
  handle,
  contractId,
  pollKey,
  scope,
  contenders,
  decided,
  names,
  replyTo,
  onCancel,
  onPosted,
  onBusyChange,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  scope: Scope;
  contenders: readonly ContenderInfo[];
  /** Voting is over: no "who do you support". */
  decided: boolean;
  names: ReadonlyMap<string, string>;
  /** Set for an inline reply. */
  replyTo?: Comment;
  onCancel?: () => void;
  onPosted: (comment?: Comment) => void;
  /** A post is being signed and sent (an inline reply's parent waits). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const session = useIdentitySession();
  const [body, setBody] = useState('');
  const [supports, setSupports] = useState('');
  // What "Review" froze: the review card and the write use this, never the
  // live fields.
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [outcome, setOutcome] = useState<WriteOutcome<Comment> | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const returning = useRef(false);
  const reply = replyTo !== undefined;
  const fieldId = reply ? `reply-body-${replyTo.id}` : 'comment-body';

  // Focus the box when a reply opens and when coming back from the review card.
  useEffect(() => {
    if (!frozen && (reply || returning.current)) textarea.current?.focus();
    returning.current = false;
  }, [reply, frozen]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  if (!session) return <SignInPrompt compact={reply} />;
  const problem = documentSigningProblem(session, contractId);
  if (problem) {
    return (
      <div className="discussion-alert">
        <p>
          This sign-in cannot post comments. <a href="#/me">Open your identity</a> to sign in with a different key.
        </p>
        <details>
          <summary>Technical detail</summary>
          <p>{problem}</p>
        </details>
      </div>
    );
  }

  const draft: CommentDraft = {
    body,
    ...(replyTo ? { replyTo: replyTo.id } : {}),
    ...(supports && !decided ? { supports } : {}),
  };
  const length = commentLength(body);
  const problems = validateDraft(draft);
  const backed = contenders.find((c) => c.id === draft.supports);
  const label = (c: ContenderInfo) => c.name ?? shortId(c.id, 6);
  const replyToName = replyTo ? (names.get(replyTo.ownerId) ?? shortId(replyTo.ownerId, 6)) : undefined;

  const done = (result: WriteOutcome<Comment>) => {
    setOutcome(result);
    if (result.status === 'confirmed' || result.status === 'pending') {
      setBody('');
      setSupports('');
      setFrozen(null);
      onPosted(result.status === 'confirmed' ? result.value : undefined);
    } else {
      // Refused or unanswered: back to the form with the text kept.
      returning.current = true;
      setFrozen(null);
    }
  };

  if (frozen) {
    return (
      <ReviewCard
        handle={handle}
        contractId={contractId}
        pollKey={pollKey}
        scope={scope}
        identityId={session.identityId}
        authorName={session.names[0]}
        frozen={frozen}
        replyToName={replyToName}
        onBack={() => {
          returning.current = true;
          setFrozen(null);
        }}
        onDone={done}
        onBusyChange={onBusyChange}
      />
    );
  }

  return (
    <div className={reply ? 'composer reply' : 'composer'}>
      {reply && <p className="composer-replying">Replying to {replyToName}</p>}
      {!reply && (
        <div className="composer-head">
          <h3>Add a comment</h3>
          <span>
            as <PersonName id={session.identityId} name={session.names[0]} />
          </span>
        </div>
      )}
      {outcome && <OutcomeNote outcome={outcome} />}
      <label className="discussion-sr-only" htmlFor={fieldId}>
        {reply ? `Reply to ${replyToName}` : 'Your comment'}
      </label>
      <textarea
        ref={textarea}
        id={fieldId}
        rows={reply ? 3 : 4}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (outcome) setOutcome(null);
        }}
        placeholder={reply ? `Reply to ${replyToName}…` : 'Share your view on this contest…'}
      />
      {!decided && contenders.length > 0 && !reply && (
        <label className="composer-supports">
          <span>Who do you support? (optional)</span>
          <select value={supports} onChange={(e) => setSupports(e.target.value)}>
            <option value="">No one in particular</option>
            {contenders.map((c) => (
              <option key={c.id} value={c.id}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="composer-actions">
        <span className={length > COMMENT_LIMIT ? 'composer-count over' : 'composer-count'}>
          {length > COMMENT_LIMIT * 0.8 ? `${length} / ${COMMENT_LIMIT}` : ''}
        </span>
        {onCancel && (
          <button type="button" className="vote-button ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="vote-button"
          disabled={problems.length > 0}
          onClick={() =>
            setFrozen({
              draft,
              backsLabel: backed ? label(backed) : undefined,
              backsColor: backed?.color,
            })
          }
        >
          Review {reply ? 'reply' : 'comment'}
        </button>
      </div>
    </div>
  );
}
