import { useState, type ReactNode } from 'react';
import { readBalance, type WriteCost } from '../../charters/writes';
import type { WriteOutcome } from '../../identity/outcome';
import { refreshIdentity } from '../../identity/session';
import { dashText } from '../../model/credits';
import type { SdkHandle } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import { useAsync } from '../useAsync';

function OutcomeNote<T>({ outcome, done }: { outcome: WriteOutcome<T>; done: string }) {
  if (outcome.status === 'confirmed') return <p className="page-note ok">{done}</p>;
  if (outcome.status === 'refused') {
    return (
      <div className="page-note error">
        <p>Platform refused it: {outcome.error.message}</p>
        {(outcome.error.code || outcome.error.detail !== outcome.error.message) && (
          <details className="technical">
            <summary>Technical detail</summary>
            <p className="mono">
              {outcome.error.code ? `code ${outcome.error.code}` : ''}
              {outcome.error.code && outcome.error.detail !== outcome.error.message ? ' · ' : ''}
              {outcome.error.detail !== outcome.error.message ? outcome.error.detail : ''}
            </p>
          </details>
        )}
      </div>
    );
  }
  if (outcome.status === 'pending') {
    return (
      <p className="page-note warn">
        Platform accepted it, but the node read back does not show it yet. Reload this page in a minute; do not
        file it again.
      </p>
    );
  }
  return (
    <div className="page-note error">
      <p>
        No answer from Platform, and it could not be found by reading back. It may still land: wait a minute
        and reload this page before trying again, or you may pay twice.
      </p>
      {outcome.error && (
        <details className="technical">
          <summary>Technical detail</summary>
          <p className="mono">{outcome.error.detail}</p>
        </details>
      )}
    </div>
  );
}

/**
 * The confirm step of a paid write: what will be written, its estimated
 * cost, the current balance, and anything that blocks it. Nothing is signed
 * until the button is pressed; the outcome is shown once read back.
 */
export function PaidWrite<T>({
  handle,
  identityId,
  title,
  summary,
  estimate,
  priceKey,
  blockers = [],
  warnings = [],
  ack,
  permanent,
  balanceChecked = false,
  confirmLabel,
  doneText,
  run,
  onDone,
  children,
  secondary,
}: {
  handle: SdkHandle;
  identityId: string;
  title: string;
  summary: Array<[string, ReactNode]>;
  estimate: () => Promise<WriteCost>;
  /** Changes when what is priced changes (re-runs the estimate). */
  priceKey?: string;
  blockers?: string[];
  warnings?: string[];
  /** A statement the user must tick before the button enables. */
  ack?: string;
  /** What is filed ("charter"), for the line saying it can never be edited or deleted. */
  permanent?: string;
  /** True when `blockers` already include the balance check (no second message). */
  balanceChecked?: boolean;
  confirmLabel: string;
  doneText: string;
  run: () => Promise<WriteOutcome<T>>;
  onDone?: (outcome: WriteOutcome<T>) => void;
  /** Extra inputs shown above the confirm step (a key field). */
  children?: ReactNode;
  /** A secondary action next to the confirm button ("← Edit", "Check again"). */
  secondary?: ReactNode;
}) {
  const priced = useAsync(
    async () => {
      const [cost, balance] = await Promise.all([estimate(), readBalance(handle.sdk, identityId)]);
      return { cost, balance };
    },
    [handle, identityId, priceKey ?? title],
  );
  const [acked, setAcked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome<T> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allBlockers = [...blockers];
  if (!balanceChecked && priced.status === 'ok' && priced.value.balance < priced.value.cost.total) {
    allBlockers.push(
      `Your balance (${dashText(priced.value.balance)}) does not cover the estimated ${dashText(priced.value.cost.total)}.`,
    );
  }
  const hideConfirm = !!ack && allBlockers.length > 0;
  const ready = priced.status === 'ok' && allBlockers.length === 0 && (!ack || acked) && !busy && !outcome;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      setOutcome(result);
      onDone?.(result);
      await refreshIdentity().catch(() => undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="paid-write">
      <h3>{title}</h3>
      <dl className="kv-table">
        {summary.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {priced.status === 'ok' && (
          <>
            {priced.value.cost.contestFund > 0n && (
              <div>
                <dt>Contest fund</dt>
                <dd>{dashText(priced.value.cost.contestFund)}: pays for the masternode vote, not refunded</dd>
              </div>
            )}
            <div>
              <dt>Fees (estimate)</dt>
              <dd>{dashText(priced.value.cost.fees)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                <strong>{dashText(priced.value.cost.total)}</strong>
              </dd>
            </div>
            <div>
              <dt>Your balance</dt>
              <dd>{dashText(priced.value.balance)}</dd>
            </div>
          </>
        )}
      </dl>
      {priced.status === 'loading' && (
        <p className="meta" role="status">
          Reading the price and your balance…
        </p>
      )}
      {priced.status === 'error' && (
        <p className="meta error">
          Could not read the price or your balance.{' '}
          <button className="link-button" onClick={priced.reload}>
            Try again
          </button>
        </p>
      )}
      {permanent && !outcome && (
        <p className="fine-print permanence">
          <strong>This is permanent.</strong> Once filed, this {permanent} cannot be edited or deleted, by you or anyone
          else.
        </p>
      )}
      {children}
      {warnings.map((w) => (
        <p key={w} className="page-note warn">
          {w}
        </p>
      ))}
      {/* Checks before signing: once the write has an outcome they no longer apply
          (the filed reason's own code, the balance after paying). */}
      {!outcome &&
        allBlockers.map((b) => (
          <p key={b} className="page-note error">
            {b}
          </p>
        ))}
      {/* A hard confirmation shows nothing to tick or press while something blocks it. */}
      {ack && !outcome && !hideConfirm && (
        <label className="ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} /> {ack}
        </label>
      )}
      <div className="paid-actions">
        {!outcome && !hideConfirm && (
          <button className="vote-button" disabled={!ready} onClick={() => void confirm()}>
            {busy ? 'Signing and waiting for Platform…' : confirmLabel}
          </button>
        )}
        {secondary}
      </div>
      {error && <p className="page-note error">{error}</p>}
      {outcome && <OutcomeNote outcome={outcome} done={doneText} />}
    </section>
  );
}
