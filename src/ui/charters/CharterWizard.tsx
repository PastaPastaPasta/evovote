import { useState } from 'react';
import { CHARTER_DECRYPTION } from '../../charters/boundKeys';
import { CHARTERS_CONTRACT_ID, type CharterReason, type RewardSplit } from '../../charters/documents';
import { proposalHref } from '../../charters/pollKey';
import { fetchReasonsByOwner, mergeReasons } from '../../charters/reads';
import {
  MAX_REASON_DESCRIPTION,
  MAX_REASON_LABEL,
  shareNote,
  splitNotes,
  validateCharter,
  validateReason,
} from '../../charters/validate';
import { estimateCharter, estimateReason, fileCharter, fileReason } from '../../charters/writes';
import { documentSigningProblem, heldBoundKeyHex, withDocumentSigner, type IdentitySession } from '../../identity/session';
import type { SdkHandle } from '../../sdk/connection';
import { targetName } from '../../kinds/charter';
import { firstSentence } from '../format';
import { BoundKeySetup } from '../identity/BoundKeySetup';
import { useAsync } from '../useAsync';
import { FieldProblems } from './FieldProblems';
import { PaidWrite } from './PaidWrite';
import { splitSentence } from './standing';

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
        title={`File the reason ${code}`}
        priceKey={`${code}|${label.length}|${description.length}`}
        summary={[
          ['Code', <span className="mono">{code}</span>],
          ['Label', label.trim()],
          ['Description', description.trim() || 'None'],
        ]}
        permanent="reason"
        estimate={() => estimateReason(handle, input)}
        blockers={problems}
        confirmLabel="Sign and file the reason"
        doneText={`Reason ${code} is filed.`}
        run={() => withDocumentSigner(handle, CHARTERS_CONTRACT_ID, (signer) => fileReason(handle, signer, input))}
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
        secondary={
          <button className="link-button" onClick={() => setReview(false)}>
            ← Edit
          </button>
        }
      />
    );
  }
  return (
    <div className="charter-form">
      <div className="form-row">
        <label className="field narrow">
          <span className="field-label">Code</span>
          <input
            className="mono"
            value={code}
            maxLength={3}
            placeholder="SPM"
            aria-describedby="reason-code-hint"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <span className="field-hint" id="reason-code-hint">
            3 capital letters
          </span>
        </label>
        <label className="field">
          <span className="field-label">Label</span>
          <input value={label} maxLength={MAX_REASON_LABEL} placeholder="Spam" onChange={(e) => setLabel(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Description (optional)</span>
        <textarea rows={2} maxLength={MAX_REASON_DESCRIPTION} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {(code || label) && <FieldProblems problems={problems} />}
      <button className="vote-button ghost" disabled={problems.length > 0} onClick={() => setReview(true)}>
        Review
      </button>
    </div>
  );
}

const SPLIT_PARTS = [
  ['leader', 'To you, the leader'],
  ['equal', 'Shared equally'],
  ['actions', 'By actions taken'],
] as const;

/** A worked example of the share and split, live as they are typed. */
function SplitExample({ share, split }: { share: number | undefined; split: RewardSplit }) {
  const parts = [split.leader, split.equal, split.actions];
  if (share === undefined || !parts.every(Number.isFinite) || parts.reduce((a, b) => a + b, 0) !== 100) return null;
  const pot = share / 100;
  const amount = (pct: number) => `${((pot * pct) / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} DASH`;
  return (
    <p className="example">
      <strong>Example:</strong> if people pay 1 DASH in moderation fees, your team takes {share}% ={' '}
      {amount(100)}. Of that, {amount(split.leader)} goes to you, {amount(split.equal)} is shared equally by the team,
      and {amount(split.actions)} is divided by how many actions each member took.
    </p>
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

  const signing = documentSigningProblem(session, CHARTERS_CONTRACT_ID);
  if (signing) return <p className="page-note error">{signing}</p>;

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

  const parts = [split.leader, split.equal, split.actions];
  const splitSum = parts.every(Number.isFinite) ? parts.reduce((a, b) => a + b, 0) : NaN;
  const shareOk = shareValue === undefined || (Number.isInteger(shareValue) && shareValue >= 0 && shareValue <= 100);
  const checklist: Array<[boolean, string]> = [
    [keyReady, 'Your decryption key is added and loaded (step 2)'],
    [description.trim() !== '' && !problems.some((p) => p.includes('bytes')), 'The charter says what your team would moderate'],
    [shareOk, "The team's share of fees is a whole number from 0 to 100"],
    [splitSum === 100 && parts.every((x) => Number.isInteger(x) && x >= 0), `The payout split adds up to 100 (now ${Number.isNaN(splitSum) ? '?' : splitSum})`],
  ];
  const ready = problems.length === 0 && keyReady;

  return (
    <div className="wizard">
      <h3>1. Reasons your team may act on</h3>
      <p className="fine-print">
        Every ban, suspension, warning and deletion your team makes must cite one of these. A charter with no
        reasons is a team that can take no such action. Reasons are yours: you can cite them in any charter you file.
      </p>
      {reasons.status === 'loading' && (
        <p className="meta" role="status">
          Reading your reasons…
        </p>
      )}
      {reasons.status === 'error' && (
        <p className="meta error">
          Could not read your reasons.{' '}
          <button className="link-button" onClick={reasons.reload}>
            Try again
          </button>
        </p>
      )}
      {reasons.status === 'ok' && ownReasons.length === 0 && <p className="meta">You have not filed any reasons yet.</p>}
      <ul className="reason-list">
        {ownReasons.map((r) => (
          <li key={r.id}>
            <label className="reason-choice">
              <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} />
              <span className="reason-code mono">{r.code}</span>
              <span>
                <strong>{r.label}</strong>
                {r.description && <span className="meta"> — {r.description}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {reasons.status === 'ok' && reasons.value.capped && (
        <p className="meta">Showing your first {ownReasons.length} reasons; filing another is turned off here.</p>
      )}
      <details>
        <summary>File a new reason</summary>
        {!codesKnown && <p className="meta">Your existing reasons must be read first, so a code is not filed twice.</p>}
        {codesKnown && (
          <NewReason
            handle={handle}
            session={session}
            existingCodes={ownReasons.map((r) => r.code)}
            onFiled={(reason) => {
              setFiled((prev) => [...prev, reason]);
              setChosen((prev) => [...prev, reason.id]);
              reasons.reload();
            }}
          />
        )}
      </details>

      <h3>2. Your decryption key</h3>
      <p className="fine-print">
        People who ask to join your team encrypt their message to this key; only you can read it.
      </p>
      <BoundKeySetup handle={handle} session={session} spec={CHARTER_DECRYPTION} what="decryption key for join requests" />

      <h3>3. The charter</h3>
      <label className="field">
        <span className="field-label">What your team would moderate, and how</span>
        <span className="field-hint">The first sentence becomes your proposal&apos;s title.</span>
        <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field narrow">
        <span className="field-label">Share of moderation fees your team takes (%)</span>
        <input inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} />
        <span className="field-hint">100 takes the whole fee the contract declares; less is a discount for the people who pay it.</span>
      </label>
      <fieldset className="split-fields">
        <legend className="field-label">How your team&apos;s earnings are split (must add up to 100)</legend>
        <div className="form-row">
          {SPLIT_PARTS.map(([part, text]) => (
            <label key={part} className="field narrow">
              <span className="field-hint">{text} %</span>
              <input
                inputMode="numeric"
                value={Number.isNaN(split[part]) ? '' : String(split[part])}
                onChange={(e) => setSplit((s) => ({ ...s, [part]: e.target.value === '' ? NaN : Number(e.target.value) }))}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <SplitExample share={shareOk ? (shareValue ?? 100) : undefined} split={split} />
      {shareNote(shareValue) && <p className="fine-print">{shareNote(shareValue)}</p>}
      {splitNotes(split, 0).map((n) => (
        <p key={n} className="fine-print">
          {n}
        </p>
      ))}
      {description.trim() !== '' && <FieldProblems problems={problems} />}
      {!review ? (
        <>
          {!ready && (
            <div className="checklist-box">
              <p className="meta">Before you can review the charter:</p>
              <ul className="checklist">
                {checklist.map(([done, text]) => (
                  <li key={text} className={done ? 'done' : ''}>
                    <span aria-hidden="true">{done ? '✓' : '○'}</span> {text}
                    <span className="visually-hidden">{done ? ' (done)' : ' (to do)'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button className="vote-button" disabled={!ready} onClick={() => setReview(true)}>
            Review the charter
          </button>
        </>
      ) : (
        <PaidWrite
          handle={handle}
          identityId={session.identityId}
          title="File the charter"
          priceKey={`${description.length}|${chosen.length}`}
          summary={[
            ['For', `Moderators of ${targetName(targetContractId)}`],
            ['Title', firstSentence(description)],
            [
              'Reasons',
              chosen.length > 0
                ? ownReasons
                    .filter((r) => chosen.includes(r.id))
                    .map((r) => `${r.code} ${r.label}`)
                    .join(', ')
                : 'None: the team could take no action',
            ],
            ['Share of fees', `${shareValue ?? 100}%`],
            ['Payout split', splitSentence(split)],
          ]}
          estimate={() => estimateCharter(handle, input)}
          blockers={[...problems, ...(keyReady ? [] : ['Add or load your decryption key first (step 2).'])]}
          permanent="charter"
          confirmLabel="Sign and file the charter"
          doneText="Your charter is filed."
          run={() =>
            withDocumentSigner(handle, CHARTERS_CONTRACT_ID, (signer) => fileCharter(handle, signer, targetContractId, input))
          }
          onDone={(outcome) => {
            if (outcome.status === 'confirmed') {
              setFiledId(outcome.value);
              onFiled();
            }
          }}
          secondary={
            <button className="link-button" onClick={() => setReview(false)}>
              ← Edit
            </button>
          }
        />
      )}
      <p className="fine-print">
        Filing a charter does not apply for the seat. Once people have asked to join, you choose your members
        and apply from the proposal page.
      </p>
    </div>
  );
}
