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
        <p>
          Platform refused it{outcome.error.code ? ` (code ${outcome.error.code})` : ''}: {outcome.error.message}
        </p>
        {outcome.error.detail !== outcome.error.message && <p className="mono-label">{outcome.error.detail}</p>}
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
      {outcome.error && <p className="mono-label">{outcome.error.detail}</p>}
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
  confirmLabel,
  doneText,
  run,
  onDone,
  children,
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
  confirmLabel: string;
  doneText: string;
  run: () => Promise<WriteOutcome<T>>;
  onDone?: (outcome: WriteOutcome<T>) => void;
  children?: ReactNode;
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
  if (priced.status === 'ok' && priced.value.balance < priced.value.cost.total) {
    allBlockers.push(
      `Your balance (${dashText(priced.value.balance)}) does not cover the estimated ${dashText(priced.value.cost.total)}.`,
    );
  }
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
            <dt className="mono-label">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {priced.status === 'ok' && (
          <>
            {priced.value.cost.contestFund > 0n && (
              <div>
                <dt className="mono-label">contest fund</dt>
                <dd>{dashText(priced.value.cost.contestFund)} (pays the masternode votes; not refunded)</dd>
              </div>
            )}
            <div>
              <dt className="mono-label">fees (estimate)</dt>
              <dd>{dashText(priced.value.cost.fees)}</dd>
            </div>
            <div>
              <dt className="mono-label">total</dt>
              <dd>
                <strong>{dashText(priced.value.cost.total)}</strong>
              </dd>
            </div>
            <div>
              <dt className="mono-label">your balance</dt>
              <dd>{dashText(priced.value.balance)}</dd>
            </div>
          </>
        )}
      </dl>
      {priced.status === 'loading' && <p className="mono-label">Reading the price and your balance…</p>}
      {priced.status === 'error' && (
        <p className="mono-label error">
          Could not read the price or your balance: {priced.message}.{' '}
          <button className="link-button" onClick={priced.reload}>
            Retry
          </button>
        </p>
      )}
      {children}
      {warnings.map((w) => (
        <p key={w} className="page-note warn">
          {w}
        </p>
      ))}
      {allBlockers.map((b) => (
        <p key={b} className="page-note error">
          {b}
        </p>
      ))}
      {ack && !outcome && (
        <label className="ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} /> {ack}
        </label>
      )}
      {!outcome && (
        <button className="vote-button" disabled={!ready} onClick={() => void confirm()}>
          {busy ? 'Signing and waiting for Platform…' : confirmLabel}
        </button>
      )}
      {error && <p className="page-note error">{error}</p>}
      {outcome && <OutcomeNote outcome={outcome} done={doneText} />}
    </section>
  );
}
