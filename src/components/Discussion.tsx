import { useCallback, useEffect, useRef, useState } from 'react';
import { commentConfirmed, fetchComments, prepareComment, publishComment, COMMENT_LIMIT, type Comment, type PreparedComment } from '../lib/discussion';
import { discussionContract, keyExchangeContract } from '../lib/discussion-config';
import type { DiscussionSession } from '../lib/discussion-auth';
import { stateTransitionUri } from '../lib/wallet';
import { errorMessage, type Network, type SdkHandle } from '../lib/sdk';
import { shortId } from '../lib/format';
import { DiscussionLogin } from './DiscussionLogin';
import { WalletRequest } from './WalletRequest';

export function Discussion({ handle, network, label }: { handle: SdkHandle; network: Network; label: string }) {
  const contractId = discussionContract(network);
  const [session, setSession] = useState<DiscussionSession>();
  const sessionRef = useRef<DiscussionSession | undefined>(undefined);
  const [comments, setComments] = useState<Comment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<Comment>();
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<PreparedComment>();
  const [posted, setPosted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const fetchGeneration = useRef(0);

  const onLogin = useCallback((next: DiscussionSession) => {
    sessionRef.current = next; setSession(next);
  }, []);
  const logout = () => {
    sessionRef.current?.privateKey?.free(); sessionRef.current = undefined;
    setSession(undefined); setPrepared(undefined); setWriteError('');
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sessionRef.current?.privateKey?.free(); };
  }, []);

  useEffect(() => {
    if (!contractId) return;
    const generation = ++fetchGeneration.current;
    setLoading(true); setReadError('');
    fetchComments(handle, contractId, label).then(result => {
      if (alive.current && generation === fetchGeneration.current) { setComments(result.comments); setHasMore(result.hasMore); }
    }).catch(e => { if (alive.current && generation === fetchGeneration.current) setReadError(errorMessage(e)); })
      .finally(() => { if (alive.current && generation === fetchGeneration.current) setLoading(false); });
  }, [handle, contractId, label, refresh]);

  const finish = useCallback(() => {
    setPrepared(undefined); setBody(''); setReply(undefined); setPosted(true);
    setWriteError(''); setRefresh(value => value + 1);
  }, []);

  useEffect(() => {
    if (!prepared || session?.mode !== 'wallet') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 180_000;
    const poll = async () => {
      try {
        if (await commentConfirmed(handle, contractId, prepared)) {
          if (!cancelled) finish();
          return;
        }
        if (!cancelled && Date.now() > deadline) {
          setWriteError('No confirmation yet. You can check again after approving in your wallet.');
          return;
        }
      } catch {
        if (!cancelled && Date.now() > deadline) { setWriteError('Could not verify your comment. Check again when Platform is reachable.'); return; }
      }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [prepared, session?.mode, handle, contractId, finish]);

  async function loadMore() {
    const generation = fetchGeneration.current;
    setLoading(true); setReadError('');
    try {
      const result = await fetchComments(handle, contractId, label, comments.at(-1)?.id);
      if (alive.current && generation === fetchGeneration.current) {
        setComments(previous => [...previous, ...result.comments.filter(next => !previous.some(old => old.id === next.id))]);
        setHasMore(result.hasMore);
      }
    } catch (e) { if (alive.current) setReadError(errorMessage(e)); }
    finally { if (alive.current && generation === fetchGeneration.current) setLoading(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!session || busy || prepared) return;
    setBusy(true); setWriteError(''); setPosted(false);
    try {
      const operation = await prepareComment(handle, contractId, session, label, body, reply?.id);
      if (!alive.current) return;
      setPrepared(operation);
      if (session.mode === 'key') {
        await publishComment(handle, session, operation);
        if (!alive.current) return;
        if (await commentConfirmed(handle, contractId, operation)) { if (alive.current) finish(); }
        else if (alive.current) setWriteError('Broadcast completed; waiting for your comment to appear. Check confirmation before trying again.');
      }
    } catch (e) {
      if (alive.current) setWriteError(errorMessage(e));
    } finally { if (alive.current) setBusy(false); }
  }

  async function checkConfirmation() {
    if (!prepared) return;
    setBusy(true); setWriteError('');
    try {
      const confirmed = await commentConfirmed(handle, contractId, prepared);
      if (alive.current) {
        if (confirmed) finish();
        else setWriteError('This comment is not confirmed yet.');
      }
    } catch (e) { if (alive.current) setWriteError(errorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }

  return (
    <section className="discussion" aria-labelledby="discussion-title">
      <div className="discussion-heading">
        <div><span className="mono-label">Community</span><h2 id="discussion-title">Discuss this contest</h2></div>
        {contractId && <button className="link-button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh</button>}
      </div>
      <p className="fine-print">Share your case, ask a question, or reply to a contender. Comments are public and permanent on Dash Platform. Official votes are cast using the ballot above.</p>
      {!contractId ? <p className="page-note">Discussion is awaiting contract activation on {network}.</p> : <>
        <div className="discussion-compose">
          {!session ? <DiscussionLogin handle={handle} network={network} contractId={contractId}
            exchangeId={keyExchangeContract(network)} onLogin={onLogin} /> : <>
            <div className="discussion-heading">
              <span className="mono" title={session.identityId}>Signed in as {shortId(session.identityId, 8)}</span>
              <button className="link-button" disabled={busy} onClick={logout}>Sign out</button>
            </div>
            <form onSubmit={event => { void submit(event); }}>
              {reply && <p>Replying to <a href={`#comment-${reply.id}`} onClick={event => { event.preventDefault(); document.getElementById(`comment-${reply.id}`)?.scrollIntoView(); }}>{shortId(reply.ownerId, 6)}</a>{' '}
                <button type="button" className="link-button" disabled={busy || !!prepared} onClick={() => setReply(undefined)}>Cancel reply</button></p>}
              <label htmlFor="comment-body">Your comment</label>
              <textarea id="comment-body" rows={4} value={body} disabled={busy || !!prepared}
                onChange={event => setBody(event.target.value)} placeholder="Add to the conversation…" />
              <div className="discussion-heading">
                <span className="fine-print">{Array.from(body.trim()).length} / {COMMENT_LIMIT} · paid with Platform credits</span>
                <button className="vote-button" disabled={busy || !!prepared || !body.trim() || Array.from(body.trim()).length > COMMENT_LIMIT}>
                  {busy ? 'Preparing…' : session.mode === 'wallet' ? 'Approve in wallet' : 'Post comment'}
                </button>
              </div>
            </form>
          </>}
          {prepared && <div className="pending-comment">
            {session?.mode === 'wallet' && <WalletRequest uri={stateTransitionUri(prepared.bytes, network)} title="Approve this comment in your wallet" />}
            <p className="fine-print">{session?.mode === 'wallet' ? 'Waiting for Platform confirmation. Approve this request only once.' : 'Comment submission is unconfirmed. Check its status before trying again.'}</p>
            <div className="discussion-actions">
              <button className="vote-button ghost" disabled={busy} onClick={() => { void checkConfirmation(); }}>Check confirmation</button>
              <button className="link-button" disabled={busy} onClick={() => { setPrepared(undefined); setWriteError(''); }}>Dismiss request</button>
            </div>
            <p className="fine-print">Dismissing does not cancel a submitted comment or a request shared with your wallet.</p>
          </div>}
          {writeError && <p className="error" role="alert">{writeError}</p>}
          {posted && <p className="success" role="status">Your comment is confirmed on Platform.</p>}
        </div>
        {readError && <p className="error" role="alert">Could not load comments: {readError}</p>}
        {!loading && !readError && !comments.length && <p className="page-note">No comments yet. Start the conversation.</p>}
        <ol className="comment-list">
          {comments.map(comment => <li className="comment" id={`comment-${comment.id}`} key={comment.id}>
            <div className="discussion-heading"><span className="mono" title={comment.ownerId}>{shortId(comment.ownerId, 8)}</span>
              <time dateTime={new Date(comment.createdAt).toISOString()}>{new Date(comment.createdAt).toLocaleString()}</time></div>
            {comment.replyTo && <p className="fine-print">Reply to comment {shortId(comment.replyTo, 6)}</p>}
            <p className="comment-body">{comment.body}</p>
            {session && <button className="link-button" disabled={busy || !!prepared} onClick={() => {
              setReply(comment); setPosted(false); document.getElementById('comment-body')?.focus();
            }}>Reply</button>}
          </li>)}
        </ol>
        {loading && <p role="status">Loading comments…</p>}
        {hasMore && <button className="vote-button ghost" disabled={loading} onClick={() => { void loadMore(); }}>Load more comments</button>}
      </>}
    </section>
  );
}
