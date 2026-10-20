import { useState } from 'react';
import { CHARTER_DECRYPTION } from '../../charters/boundKeys';
import { CHARTERS_CONTRACT_ID, splitText, type CharterReason, type RewardSplit } from '../../charters/documents';
import { proposalHref } from '../../charters/pollKey';
import { fetchReasonsByOwner, mergeReasons } from '../../charters/reads';
import {
  MAX_REASON_DESCRIPTION,
  MAX_REASON_LABEL,
  shareNote,
  validateCharter,
  validateReason,
} from '../../charters/validate';
import { estimateCharter, estimateReason, fileCharter, fileReason } from '../../charters/writes';
import { documentSigningProblem, heldBoundKeyHex, withDocumentSigner, type IdentitySession } from '../../identity/session';
import { SigningProblemNote } from '../identity/SigningProblemNote';
import type { SdkHandle } from '../../sdk/connection';
import { shortId } from '../format';
import { BoundKeySetup } from '../identity/BoundKeySetup';
import { useAsync } from '../useAsync';
import { FieldProblems } from './FieldProblems';
import { PaidWrite } from './PaidWrite';

function NewReason({
  handle,
  session,
  existingCodes,
  onFiled,
}: {
  handle: SdkHandle;
  session: IdentitySession;
  existingCodes: string[];
  onFiled: (reason: CharterReason) => void;
}) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [review, setReview] = useState(false);
  const input = { code, label, description };
  const problems = validateReason(input, existingCodes);
  if (review) {
    return (
      <PaidWrite
        handle={handle}
        identityId={session.identityId}
        title={`File reason ${code}`}
        priceKey={`${code}|${label.length}|${description.length}`}
        summary={[
          ['code', code],
          ['label', label.trim()],
          ['description', description.trim() || '(none)'],
        ]}
        estimate={() => estimateReason(handle, input)}
        blockers={problems}
        confirmLabel="Sign and file the reason"
        doneText={`Reason ${code} is filed.`}
        run={() => withDocumentSigner(handle, { contractId: CHARTERS_CONTRACT_ID, documentType: 'reason' }, (signer) => fileReason(handle, signer, input))}
        onDone={(outcome) => {
          if (outcome.status !== 'confirmed') return;
          onFiled({
            id: outcome.value,
            ownerId: session.identityId,
            code,
            label: label.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
          });
        }}
      >
        <button className="link-button" onClick={() => setReview(false)}>
          ← Edit
        </button>
      </PaidWrite>
    );
  }
  return (
    <div className="charter-form">
      <div className="form-row">
        <label className="field narrow">
          <span className="mono-label">Code</span>
          <input value={code} maxLength={3} placeholder="SPM" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <label className="field">
          <span className="mono-label">Label</span>
          <input value={label} maxLength={MAX_REASON_LABEL} placeholder="Spam" onChange={(e) => setLabel(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="mono-label">Description (optional)</span>
        <textarea rows={2} maxLength={MAX_REASON_DESCRIPTION} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {(code || label) && <FieldProblems problems={problems} />}
      <button className="vote-button ghost" disabled={problems.length > 0} onClick={() => setReview(true)}>
        Review
      </button>
    </div>
  );
}

/**
 * "Propose a moderation team" (design §4.5): choose or file reasons, make
 * sure the leader's decryption key exists, then file the `submittedCharter`.
 */
export function CharterWizard({
  handle,
  session,
  targetContractId,
  onFiled,
}: {
  handle: SdkHandle;
  session: IdentitySession;
  targetContractId: string;
  onFiled: () => void;
}) {
  const reasons = useAsync(() => fetchReasonsByOwner(handle.sdk, session.identityId), [handle, session.identityId]);
  const [chosen, setChosen] = useState<string[]>([]);
  // Reasons filed here, listed until a read has them (see mergeReasons).
  const [filed, setFiled] = useState<CharterReason[]>([]);
  const [description, setDescription] = useState('');
  const [share, setShare] = useState('100');
  const [split, setSplit] = useState<RewardSplit>({ leader: 40, equal: 30, actions: 30 });
  const [review, setReview] = useState(false);
  const [filedId, setFiledId] = useState<string | null>(null);

  const signing = documentSigningProblem(session, { contractId: CHARTERS_CONTRACT_ID, documentType: 'submittedCharter' });
  if (signing) return <SigningProblemNote problem={signing} />;

  const keyReady = !!heldBoundKeyHex(session, CHARTER_DECRYPTION);
  const shareValue = share.trim() === '' ? undefined : Number(share);
  const input = {
    description,
    reasonIds: chosen,
    moderatorsShare: shareValue === 100 ? undefined : shareValue,
    rewardSplit: split,
  };
  const problems = validateCharter(input);
  const read = reasons.status === 'ok' ? reasons.value.reasons : [];
  const ownReasons =
    reasons.status === 'ok' ? mergeReasons(read, filed.filter((r) => r.ownerId === session.identityId)) : [];
  // A code must be unique per identity: filing needs the full list of the ones taken.
  const codesKnown = reasons.status === 'ok' && !reasons.value.capped;
  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (filedId) {
    return (
      <p className="page-note ok">
        Your proposal is filed. <a href={proposalHref(targetContractId, filedId)}>Open it</a> to share it with
        people who may join your team.
      </p>
    );
  }

  return (
    <div className="wizard">
      <h3>1. Reasons your team may act on</h3>
      <p className="fine-print">
        Every ban, suspension, warning and deletion your team makes must cite one of these. A charter with no
        reasons is a team that can take no such action.
      </p>
      {reasons.status === 'loading' && <p className="mono-label">Reading your reasons…</p>}
      {reasons.status === 'error' && (
        <p className="mono-label error">
          Could not read your reasons: {reasons.message}{' '}
          <button className="link-button" onClick={reasons.reload}>
            Retry
          </button>
        </p>
      )}
      {reasons.status === 'ok' && ownReasons.length === 0 && <p className="mono-label">You have filed no reasons yet.</p>}
      <ul className="reason-list">
        {ownReasons.map((r) => (
          <li key={r.id}>
            <label>
              <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} />{' '}
              <strong className="mono">{r.code}</strong> {r.label}
              {r.description && <span className="fine-print"> — {r.description}</span>}
            </label>
          </li>
        ))}
      </ul>
      {reasons.status === 'ok' && reasons.value.capped && (
        <p className="mono-label">Showing your first {ownReasons.length} reasons; filing another is turned off here.</p>
      )}
      <details>
        <summary>File a new reason</summary>
        {!codesKnown && <p className="mono-label">Your existing reasons must be read first, so a code is not filed twice.</p>}
        {codesKnown && <NewReason
          handle={handle}
          session={session}
          existingCodes={ownReasons.map((r) => r.code)}
          onFiled={(reason) => {
            setFiled((prev) => [...prev, reason]);
            setChosen((prev) => [...prev, reason.id]);
            reasons.reload();
          }}
        />}
      </details>

      <h3>2. Your decryption key</h3>
      <p className="fine-print">
        People who ask to join your team encrypt their message to this key; only you can read it.
      </p>
      <BoundKeySetup handle={handle} session={session} spec={CHARTER_DECRYPTION} what="decryption key for join requests" />

      <h3>3. The charter</h3>
      <label className="field">
        <span className="mono-label">What your team would moderate, and how</span>
        <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="form-row">
        <label className="field narrow">
          <span className="mono-label">Moderators&apos; share %</span>
          <input inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} />
        </label>
        {(['leader', 'equal', 'actions'] as const).map((part) => (
          <label key={part} className="field narrow">
            <span className="mono-label">{part === 'actions' ? 'by actions %' : `${part} %`}</span>
            <input
              inputMode="numeric"
              value={Number.isNaN(split[part]) ? '' : String(split[part])}
              onChange={(e) => setSplit((s) => ({ ...s, [part]: e.target.value === '' ? NaN : Number(e.target.value) }))}
            />
          </label>
        ))}
      </div>
      <p className="fine-print">
        The share is the part of each declared moderators fee your team takes (100 = all of it). The split says
        how a claim is paid out: to the leader, equally to the other members, and by each one&apos;s action count.
        It must add up to 100.
      </p>
      {shareNote(shareValue) && <p className="fine-print">{shareNote(shareValue)}</p>}
      {description.trim() !== '' && <FieldProblems problems={problems} />}
      {!review ? (
        <button className="vote-button" disabled={problems.length > 0 || !keyReady} onClick={() => setReview(true)}>
          Review the charter
        </button>
      ) : (
        <PaidWrite
          handle={handle}
          identityId={session.identityId}
          title="File the charter"
          priceKey={`${description.length}|${chosen.length}`}
          summary={[
            ['target', <span className="mono">{shortId(targetContractId, 8)}</span>],
            ['reasons', chosen.length > 0 ? ownReasons.filter((r) => chosen.includes(r.id)).map((r) => r.code).join(', ') : 'none'],
            ["moderators' share", `${shareValue ?? 100}%`],
            ['reward split', splitText(split)],
            ['description', `${description.trim().slice(0, 160)}${description.trim().length > 160 ? '…' : ''}`],
          ]}
          estimate={() => estimateCharter(handle, input)}
          blockers={[...problems, ...(keyReady ? [] : ['Add or load your decryption key first (step 2).'])]}
          confirmLabel="Sign and file the charter"
          doneText="Your charter is filed."
          run={() =>
            withDocumentSigner(handle, { contractId: CHARTERS_CONTRACT_ID, documentType: 'submittedCharter' }, (signer) => fileCharter(handle, signer, targetContractId, input))
          }
          onDone={(outcome) => {
            if (outcome.status === 'confirmed') {
              setFiledId(outcome.value);
              onFiled();
            }
          }}
        >
          <button className="link-button" onClick={() => setReview(false)}>
            ← Edit
          </button>
        </PaidWrite>
      )}
      <p className="fine-print">
        Filing a charter does not apply for the seat. Once people have asked to join, you choose your members
        and apply from the proposal page.
      </p>
    </div>
  );
}
