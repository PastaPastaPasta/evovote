import { useMemo, useState, type ReactNode } from 'react';
import { CHARTER_DECRYPTION } from '../../charters/boundKeys';
import { durationText } from '../../charters/declaration';
import { CHARTERS_CONTRACT_ID, type CharterProposal, type JoinRequestMeta } from '../../charters/documents';
import { MAX_ELECTED_MEMBERS, splitNotes } from '../../charters/validate';
import {
  applyForSeat,
  buildApplication,
  decryptJoinRequests,
  documentSummary,
  preflightApply,
  type ApplicationArgs,
  type ApplyPreflight,
  type DecryptedJoinRequest,
} from '../../charters/writes';
import { documentSigningProblem, heldBoundKeyHex, withDocumentSigner, type IdentitySession } from '../../identity/session';
import { dashText } from '../../model/credits';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import { freeQuietly } from '../../sdk/free';
import { targetName } from '../../kinds/charter';
import { dateText, firstSentence, shortId } from '../format';
import { IdentityName } from '../components/IdentityName';
import { TechnicalDetail } from '../components/TechnicalDetail';
import { BoundKeySetup } from '../identity/BoundKeySetup';
import { PaidWrite } from './PaidWrite';

/** The statement ticked before applying, naming the fund Platform asks for now. */
const applyAck = (fund: string) =>
  `I understand: if this team wins, it holds the seat permanently (protocol 14 has no challenges); the ${fund} contest fund is not refunded, win or lose; a tie goes to the team that applied first; and an application Platform refuses still costs its fees.`;

/**
 * What the application document says, read back from the built document
 * and shown by name: the contract, the proposal's title and each member.
 */
function applicationRows(handle: SdkHandle, args: ApplicationArgs, proposal: CharterProposal): Array<[string, ReactNode]> {
  let doc: ReturnType<typeof buildApplication>;
  try {
    doc = buildApplication(handle.mod, args);
  } catch (e) {
    return [['Application', `could not be built: ${errorMessage(e)}`]];
  }
  try {
    const s = documentSummary(doc);
    const members = Array.isArray(s.members) ? (s.members as string[]) : [];
    const target = String(s.targetContractId);
    return [
      ['Seat', `Moderators of ${targetName(target)}`],
      ['Proposal', String(s.submittedCharterId) === proposal.id ? firstSentence(proposal.description) : shortId(String(s.submittedCharterId))],
      [
        'Members',
        members.length > 0 ? (
          <>
            {members.map((m, i) => (
              <span key={m}>
                {i > 0 && ', '}
                <IdentityName sdk={handle.sdk} id={m} />
              </span>
            ))}
          </>
        ) : (
          'None besides you'
        ),
      ],
    ];
  } finally {
    freeQuietly(doc);
  }
}

function timingRows(pre: ApplyPreflight): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const t = pre.status.timing;
  const contenders = pre.status.contest?.tally.contenders.length ?? 0;
  if (contenders === 0) {
    rows.push([
      'If you apply first',
      pre.joinWindowSeconds !== undefined
        ? `The race opens. Other teams then have ${durationText(pre.joinWindowSeconds)} to apply; if none does, you win when that window closes.`
        : 'The race opens.',
    ]);
    if (pre.voteWindowSeconds !== undefined) {
      rows.push(['If another team applies', `Masternodes get ${durationText(pre.voteWindowSeconds)} more to vote.`]);
    }
  } else {
    rows.push(['Teams applied so far', String(contenders)]);
    if (t.joinClosesAtMs) rows.push(['Applications close', dateText(t.joinClosesAtMs)]);
    if (t.endsAtMs) rows.push(['Voting ends', dateText(t.endsAtMs)]);
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
  const decryptionHex = heldBoundKeyHex(session, CHARTER_DECRYPTION);
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
  const appRows = useMemo(() => applicationRows(handle, args, proposal), [handle, args, proposal]);

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
      <h3>1. Choose your members · {joiners.length} asked to join</h3>
      <BoundKeySetup handle={handle} session={session} spec={CHARTER_DECRYPTION} what="decryption key for join requests" />
      {decryptionHex && joiners.length > 0 && (
        <button className="vote-button ghost" disabled={decrypting} onClick={() => void readMessages()}>
          {decrypting ? 'Decrypting…' : 'Read their messages'}
        </button>
      )}
      {decryptError && (
        <div className="page-note error">
          <p>Could not read the messages.</p>
          <TechnicalDetail>{decryptError}</TechnicalDetail>
        </div>
      )}
      {joiners.length === 0 && <p className="meta">Nobody has asked to join yet. You can still apply alone.</p>}
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
                {r.createdAtMs && <span className="meta"> · asked {dateText(r.createdAtMs, { time: false })}</span>}
              </label>
              {m?.message !== undefined && <blockquote className="join-message">{m.message}</blockquote>}
              {m?.error && <p className="mono-label error">{m.error}</p>}
            </li>
          );
        })}
      </ul>
      <p className="meta">
        {members.length} of at most {MAX_ELECTED_MEMBERS} members chosen. Only people who asked to join can be listed.
      </p>

      <h3>2. Apply for the seat</h3>
      <p className="fine-print">
        Applying takes a contest fund (0.5 DASH while nobody has applied yet) plus fees. The fund pays for the masternode vote and is not refunded,
        win or lose. Nothing is signed until you confirm.
      </p>
      {signing && <p className="page-note error">{signing}</p>}
      {!signing && preflight === null && (
        <button className="vote-button" onClick={() => void prepare()}>
          Check and prepare the application
        </button>
      )}
      {preflight === 'loading' && (
        <p className="meta" role="status">
          Reading the election, your balance and the fund…
        </p>
      )}
      {preflight && typeof preflight === 'object' && 'error' in preflight && (
        <div className="page-note error">
          <p>
            Could not prepare the application.{' '}
            <button className="link-button" onClick={() => void prepare()}>
              Try again
            </button>
          </p>
          <TechnicalDetail>{preflight.error}</TechnicalDetail>
        </div>
      )}
      {preflight && typeof preflight === 'object' && 'status' in preflight && (
        <PaidWrite
          handle={handle}
          identityId={session.identityId}
          title="Apply for the moderation seat"
          priceKey={`${members.join(',')}|${dashText(preflight.cost.total)}`}
          summary={[...appRows, ...timingRows(preflight), ['If votes tie', 'The team that applied first wins.']]}
          estimate={async () => preflight.cost}
          blockers={preflight.blockers}
          balanceChecked
          permanent="application"
          warnings={[...preflight.warnings, ...splitNotes(proposal.rewardSplit, members.length)]}
          ack={applyAck(dashText(preflight.cost.contestFund))}
          confirmLabel={`Sign and apply (${dashText(preflight.cost.total)})`}
          doneText="You are a contender for the seat. Masternodes can now vote; share the contest page."
          run={() =>
            withDocumentSigner(handle, CHARTERS_CONTRACT_ID, async (signer) => {
              // The election may have moved since the check (a rival applied
              // or won, the window closed): read it again right before signing.
              const fresh = await preflightApply(handle, args);
              if (fresh.blockers.length > 0) {
                setPreflight(fresh);
                throw new Error(`Not applied: ${fresh.blockers.join(' ')}`);
              }
              if (fresh.cost.total > preflight.cost.total) {
                setPreflight(fresh);
                throw new Error('The price changed since the check. Review the new total and confirm again.');
              }
              const application = buildApplication(handle.mod, args);
              try {
                return await applyForSeat(handle, signer, application, args.targetContractId, fresh.cost.contestFund);
              } finally {
                freeQuietly(application);
              }
            })
          }
          onDone={(outcome) => {
            if (outcome.status === 'confirmed') onApplied();
          }}
          secondary={
            <button className="link-button" onClick={() => void prepare()}>
              Check again
            </button>
          }
        />
      )}
    </div>
  );
}
