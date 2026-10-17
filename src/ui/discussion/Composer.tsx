import { useState } from 'react';
import { estimateComment, commentLength, COMMENT_LIMIT, postComment, validateDraft, type CommentDraft } from '../../discussion/writes';
import type { Comment } from '../../discussion/reads';
import type { Scope } from '../../discussion/scope';
import type { WriteOutcome } from '../../identity/outcome';
import { documentSigningProblem, useIdentitySession, withDocumentSigner } from '../../identity/session';
import type { PollKey } from '../../model/pollKey';
import type { SdkHandle } from '../../sdk/connection';
import { PaidWrite } from '../charters/PaidWrite';
import { PersonName } from './CommentItem';

/**
 * The compose box. It needs the identity session (`#/me`); "Review" opens the
 * paid-write confirm step with the fee estimate and balance, and the comment
 * is only shown as posted once it has been read back from Platform.
 */
export function Composer({
  handle,
  contractId,
  pollKey,
  scope,
  contenders,
  names,
  replyingTo,
  onCancelReply,
  onPosted,
}: {
  handle: SdkHandle;
  contractId: string;
  pollKey: PollKey;
  scope: Scope;
  contenders: readonly string[];
  names: ReadonlyMap<string, string>;
  replyingTo?: Comment;
  onCancelReply: () => void;
  onPosted: () => void;
}) {
  const session = useIdentitySession();
  const [body, setBody] = useState('');
  const [supports, setSupports] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome<Comment> | null>(null);

  if (!session) {
    return (
      <p className="page-note">
        <a href="#/me">Sign in</a> with your identity to comment. You need a HIGH or CRITICAL authentication key.
      </p>
    );
  }
  const problem = documentSigningProblem(session, contractId);
  if (problem) {
    return (
      <p className="page-note error">
        {problem} <a href="#/me">Open my identity</a>
      </p>
    );
  }

  const draft: CommentDraft = {
    body,
    ...(replyingTo ? { replyTo: replyingTo.id } : {}),
    ...(supports ? { supports } : {}),
  };
  const length = commentLength(body);
  const problems = validateDraft(draft);

  const reset = () => {
    setBody('');
    setSupports('');
    setReviewing(false);
    setOutcome(null);
    onCancelReply();
  };

  return (
    <div className="discussion-compose">
      <p className="fine-print">
        Signed in as <PersonName id={session.identityId} name={session.names[0]} />. Comments are public and
        permanent: they cannot be edited or deleted. Plain text only. Official votes are cast with the ballot above.
      </p>
      {replyingTo && (
        <p className="fine-print">
          Replying to <PersonName id={replyingTo.ownerId} name={names.get(replyingTo.ownerId)} />{' '}
          <button type="button" className="link-button" disabled={reviewing} onClick={onCancelReply}>
            Cancel reply
          </button>
        </p>
      )}
      {!outcome && (
        <>
          <label className="field">
            <span className="mono-label">Your comment</span>
            <textarea
              id="comment-body"
              rows={4}
              value={body}
              disabled={reviewing}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add to the conversation…"
            />
          </label>
          {contenders.length > 0 && (
            <label className="field">
              <span className="mono-label">Who do you support? (optional)</span>
              <select value={supports} disabled={reviewing} onChange={(e) => setSupports(e.target.value)}>
                <option value="">No one in particular</option>
                {contenders.map((id) => (
                  <option key={id} value={id}>
                    {names.get(id) ?? id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="discussion-actions">
            <span className={length > COMMENT_LIMIT ? 'fine-print error' : 'fine-print'}>
              {length} / {COMMENT_LIMIT}
            </span>
            {!reviewing ? (
              <button className="vote-button" disabled={problems.length > 0} onClick={() => setReviewing(true)}>
                Review and post
              </button>
            ) : (
              <button className="link-button" disabled={writing} onClick={() => setReviewing(false)}>
                Edit
              </button>
            )}
          </div>
        </>
      )}
      {reviewing && problems.length === 0 && (
        <PaidWrite<Comment>
          handle={handle}
          identityId={session.identityId}
          title="Post this comment"
          summary={[
            ['comment', <span className="comment-body" key="b">{body.trim()}</span>],
            ...(supports ? ([['supports', names.get(supports) ?? supports]] as Array<[string, string]>) : []),
            ...(replyingTo ? ([['reply to', names.get(replyingTo.ownerId) ?? replyingTo.ownerId]] as Array<[string, string]>) : []),
          ]}
          estimate={() => estimateComment(handle, contractId, scope, draft)}
          priceKey={`${body.trim()}|${supports}|${replyingTo?.id ?? ''}`}
          confirmLabel="Post comment"
          doneText="Your comment is on Platform."
          run={async () => {
            setWriting(true);
            try {
              return await withDocumentSigner(handle, contractId, (signer) =>
                postComment(handle, signer, contractId, pollKey, draft),
              );
            } finally {
              setWriting(false);
            }
          }}
          onDone={(result) => {
            setOutcome(result);
            if (result.status === 'confirmed' || result.status === 'pending') onPosted();
          }}
        />
      )}
      {outcome &&
        (outcome.status === 'confirmed' || outcome.status === 'pending' ? (
          <button className="vote-button ghost" onClick={reset}>
            Write another
          </button>
        ) : (
          // Refused or unanswered: keep the text so it can be fixed or retried.
          <button
            className="vote-button ghost"
            onClick={() => {
              setOutcome(null);
              setReviewing(false);
            }}
          >
            Back to editing
          </button>
        ))}
    </div>
  );
}
