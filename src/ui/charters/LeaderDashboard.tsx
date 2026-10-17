import { useMemo, useState } from 'react';
import { CHARTER_DECRYPTION } from '../../charters/boundKeys';
import { durationText } from '../../charters/declaration';
import { CHARTERS_CONTRACT_ID, type CharterProposal, type JoinRequestMeta } from '../../charters/documents';
import { MAX_ELECTED_MEMBERS } from '../../charters/validate';
import {
  applyForSeat,
  buildApplication,
  canApplyNow,
  decryptJoinRequests,
  documentSummary,
  preflightApply,
  type ApplyPreflight,
  type DecryptedJoinRequest,
} from '../../charters/writes';
import { existingBoundKey } from '../../identity/update';
import { documentSigningProblem, heldPrivateKeyFor, withDocumentSigner, type IdentitySession } from '../../identity/session';
import { dashText } from '../../model/credits';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import { freeQuietly } from '../../sdk/free';
import { shortId } from '../format';
import { IdentityName } from '../components/IdentityName';
import { BoundKeySetup } from '../identity/BoundKeySetup';
import { PaidWrite } from './PaidWrite';

const APPLY_ACK =
  'I understand: if this team wins, it holds the seat permanently (protocol 14 has no challenges); the contest fund is not refunded, win or lose; a tie goes to the earliest application; and an application Platform refuses still pays its fees.';

/** What the application document says, read back from the built document. */
function applicationRows(handle: SdkHandle, args: Parameters<typeof buildApplication>[1]): Array<[string, string]> {
  const doc = buildApplication(handle.mod, args);
  try {
    const s = documentSummary(doc);
    const members = Array.isArray(s.members) ? (s.members as string[]) : [];
    return [
      ['target contract', String(s.targetContractId)],
      ['proposal', String(s.submittedCharterId)],
      ['members', members.length > 0 ? members.map((m) => shortId(m, 6)).join(', ') : 'none besides you'],
    ];
  } finally {
    freeQuietly(doc);
  }
}

function timingRows(pre: ApplyPreflight): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (pre.joinWindowSeconds !== undefined && pre.voteWindowSeconds !== undefined) {
    rows.push([
      'windows',
      `join ${durationText(pre.joinWindowSeconds)}, then vote ${durationText(pre.voteWindowSeconds)} once a second team applies`,
    ]);
  }
  const t = pre.status.timing;
  const contenders = pre.status.contest?.tally.contenders.length ?? 0;
  if (contenders === 0) {
    rows.push([
      'if you apply first',
      pre.joinWindowSeconds !== undefined
        ? `the contest opens; with no other applicant you win when the join window closes (${durationText(pre.joinWindowSeconds)})`
        : 'the contest opens',
    ]);
  } else {
    rows.push(['contenders now', String(contenders)]);
    if (t.joinClosesAtMs) rows.push(['join window closes', new Date(t.joinClosesAtMs).toLocaleString()]);
    if (t.endsAtMs) rows.push(['voting ends', new Date(t.endsAtMs).toLocaleString()]);
  }
  return rows;
}

/**
 * The leader's view of a proposal: read the join requests, choose up to 15
 * members, and apply for the seat behind a hard confirmation.
 */
export function LeaderDashboard({
  handle,
  session,
  proposal,
  joinRequests,
  onApplied,
}: {
  handle: SdkHandle;
  session: IdentitySession;
  proposal: CharterProposal;
  joinRequests: JoinRequestMeta[];
  onApplied: () => void;
}) {
  const [members, setMembers] = useState<string[]>([]);
  const [messages, setMessages] = useState<Record<string, DecryptedJoinRequest>>({});
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ApplyPreflight | 'loading' | { error: string } | null>(null);

  const signing = documentSigningProblem(session, CHARTERS_CONTRACT_ID);
  const decryptionKey = existingBoundKey(session.keys, CHARTER_DECRYPTION);
  const decryptionHex = decryptionKey ? heldPrivateKeyFor(decryptionKey) : undefined;
  const joiners = joinRequests.filter((r) => r.memberId !== session.identityId);
  const args = useMemo(
    () => ({
      targetContractId: proposal.targetContractId,
      leaderId: session.identityId,
      submittedCharterId: proposal.id,
      members,
    }),
    [proposal.targetContractId, proposal.id, session.identityId, members],
  );
  const appRows = useMemo(() => applicationRows(handle, args), [handle, args]);

  const readMessages = async () => {
    if (!decryptionHex) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const { requests } = await decryptJoinRequests(handle, proposal.id, decryptionHex);
      setMessages(Object.fromEntries(requests.map((r) => [r.memberId, r])));
    } catch (e) {
      setDecryptError(errorMessage(e));
    } finally {
      setDecrypting(false);
    }
  };

  const prepare = async () => {
    setPreflight('loading');
    try {
      setPreflight(await preflightApply(handle, args));
    } catch (e) {
      setPreflight({ error: errorMessage(e) });
    }
  };

  const toggle = (id: string) => {
    setPreflight(null);
    setMembers((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  return (
    <div className="wizard">
      <h3>Join requests ({joiners.length})</h3>
      <BoundKeySetup handle={handle} session={session} spec={CHARTER_DECRYPTION} what="decryption key for join requests" />
      {decryptionHex && joiners.length > 0 && (
        <button className="vote-button ghost" disabled={decrypting} onClick={() => void readMessages()}>
          {decrypting ? 'Decrypting…' : 'Read their messages'}
        </button>
      )}
      {decryptError && <p className="mono-label error">Could not read the messages: {decryptError}</p>}
      {joiners.length === 0 && <p className="mono-label">Nobody has asked to join yet. You can still apply alone.</p>}
      <ul className="joiner-list">
        {joiners.map((r) => {
          const m = messages[r.memberId];
          const disabled = !members.includes(r.memberId) && members.length >= MAX_ELECTED_MEMBERS;
          return (
            <li key={r.id}>
              <label>
                <input
                  type="checkbox"
                  checked={members.includes(r.memberId)}
                  disabled={disabled}
                  onChange={() => toggle(r.memberId)}
                />{' '}
                <IdentityName sdk={handle.sdk} id={r.memberId} />
                {r.createdAtMs && <span className="mono-label"> · {new Date(r.createdAtMs).toLocaleDateString()}</span>}
              </label>
              {m?.message !== undefined && <blockquote className="join-message">{m.message}</blockquote>}
              {m?.error && <p className="mono-label error">{m.error}</p>}
            </li>
          );
        })}
      </ul>
      <p className="mono-label">
        {members.length} of at most {MAX_ELECTED_MEMBERS} members chosen.
      </p>

      <h3>Apply for the seat</h3>
      {signing && <p className="page-note error">{signing}</p>}
      {!signing && preflight === null && (
        <button className="vote-button" onClick={() => void prepare()}>
          Check and prepare the application
        </button>
      )}
      {preflight === 'loading' && <p className="mono-label">Reading the election, your balance and the fund…</p>}
      {preflight && typeof preflight === 'object' && 'error' in preflight && (
        <p className="page-note error">
          Could not prepare the application: {preflight.error}{' '}
          <button className="link-button" onClick={() => void prepare()}>
            Retry
          </button>
        </p>
      )}
      {preflight && typeof preflight === 'object' && 'status' in preflight && (
        <PaidWrite
          handle={handle}
          identityId={session.identityId}
          title="Apply for the moderation seat"
          priceKey={`${members.join(',')}|${dashText(preflight.cost.total)}`}
          summary={[...appRows, ...timingRows(preflight), ['tie rule', 'a tie goes to the earliest application']]}
          estimate={async () => preflight.cost}
          blockers={preflight.blockers}
          warnings={preflight.warnings}
          ack={APPLY_ACK}
          confirmLabel={`Sign and apply (${dashText(preflight.cost.total)})`}
          doneText="You are a contender for the seat. Masternodes can now vote; share the contest page."
          run={() =>
            withDocumentSigner(handle, CHARTERS_CONTRACT_ID, async (signer) => {
              // The join window may have closed since the check.
              const still = canApplyNow(preflight);
              if (!still.ok) throw new Error(still.reason);
              const application = buildApplication(handle.mod, args);
              try {
                return await applyForSeat(handle, signer, application, args.targetContractId, preflight.cost.contestFund);
              } finally {
                freeQuietly(application);
              }
            })
          }
          onDone={(outcome) => {
            if (outcome.status === 'confirmed') onApplied();
          }}
        >
          <button className="link-button" onClick={() => void prepare()}>
            Check again
          </button>
        </PaidWrite>
      )}
    </div>
  );
}
