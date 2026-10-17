import { useState } from 'react';
import { JOIN_ENCRYPTION } from '../../charters/boundKeys';
import { CHARTERS_CONTRACT_ID, type CharterProposal, type JoinRequestMeta } from '../../charters/documents';
import { leaderCanReceive } from '../../charters/reads';
import { validateJoinMessage } from '../../charters/validate';
import { estimateJoinRequest, fileJoinRequest } from '../../charters/writes';
import { existingBoundKey } from '../../identity/update';
import { documentSigningProblem, heldPrivateKeyFor, withDocumentSigner, type IdentitySession } from '../../identity/session';
import type { SdkHandle } from '../../sdk/connection';
import { BoundKeySetup } from '../identity/BoundKeySetup';
import { useAsync } from '../useAsync';
import { PaidWrite } from './PaidWrite';

/** Ask to join a proposal's team: an encrypted message only the leader can read. */
export function JoinPanel({
  handle,
  session,
  proposal,
  joinRequests,
  onJoined,
}: {
  handle: SdkHandle;
  session: IdentitySession;
  proposal: CharterProposal;
  joinRequests: JoinRequestMeta[];
  onJoined: () => void;
}) {
  const leaderReady = useAsync(() => leaderCanReceive(handle.sdk, proposal.leaderId), [handle, proposal.leaderId]);
  const [message, setMessage] = useState('');
  const [review, setReview] = useState(false);

  const mine = joinRequests.find((r) => r.memberId === session.identityId);
  if (mine) {
    return (
      <p className="page-note ok">
        You asked to join this team
        {mine.createdAtMs ? ` on ${new Date(mine.createdAtMs).toLocaleString()}` : ''}. The leader decides whether
        to list you when applying for the seat.
      </p>
    );
  }
  const signing = documentSigningProblem(session, CHARTERS_CONTRACT_ID);
  if (signing) return <p className="page-note error">{signing}</p>;
  if (leaderReady.status === 'loading') return <p className="mono-label">Checking the leader&apos;s keys…</p>;
  if (leaderReady.status === 'error') {
    return <p className="page-note error">Could not read the leader&apos;s keys: {leaderReady.message}</p>;
  }
  if (!leaderReady.value) {
    return (
      <p className="page-note warn">
        The leader has not added a decryption key for join requests yet, so nobody can ask to join this team.
      </p>
    );
  }

  const encryptionKey = existingBoundKey(session.keys, JOIN_ENCRYPTION);
  const privateKeyHex = encryptionKey ? heldPrivateKeyFor(encryptionKey) : undefined;
  const problems = validateJoinMessage(message);
  const bytes = new TextEncoder().encode(message).length;

  return (
    <div className="wizard">
      <h3>1. Your encryption key</h3>
      <p className="fine-print">Your message to the leader is encrypted with this key.</p>
      <BoundKeySetup handle={handle} session={session} spec={JOIN_ENCRYPTION} what="encryption key for join requests" />
      <h3>2. Your message to the leader</h3>
      <label className="field">
        <span className="mono-label">Why you want to join (only the leader can read it; at most 1023 bytes)</span>
        <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {message && problems.map((p) => (
        <p key={p} className="mono-label error">
          {p}
        </p>
      ))}
      {!review ? (
        <button className="vote-button" disabled={problems.length > 0 || !privateKeyHex} onClick={() => setReview(true)}>
          Review
        </button>
      ) : (
        <PaidWrite
          handle={handle}
          identityId={session.identityId}
          title="Ask to join"
          priceKey={String(bytes)}
          summary={[
            ['proposal', proposal.id],
            ['message', `${bytes} bytes, encrypted to the leader`],
          ]}
          estimate={() => estimateJoinRequest(handle, message)}
          blockers={[...problems, ...(privateKeyHex ? [] : ['Add or load your encryption key first (step 1).'])]}
          confirmLabel="Sign and send the join request"
          doneText="Your join request is filed. The leader can now list you as a member."
          run={() =>
            withDocumentSigner(handle, CHARTERS_CONTRACT_ID, (signer) =>
              fileJoinRequest(handle, signer, {
                submittedCharterId: proposal.id,
                message,
                encryptionPrivateKeyHex: privateKeyHex!,
              }),
            )
          }
          onDone={(outcome) => {
            if (outcome.status === 'confirmed') onJoined();
          }}
        >
          <button className="link-button" onClick={() => setReview(false)}>
            ← Edit
          </button>
        </PaidWrite>
      )}
    </div>
  );
}
