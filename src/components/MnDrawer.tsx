import { useState } from 'react';
import {
  addMasternode,
  bulkImport,
  forgetKey,
  importKey,
  removeMasternode,
  useMasternodes,
} from '../lib/mn';
import { plural, shortId } from '../lib/format';
import type { Network } from '../lib/sdk';

function KeyField({ mnId }: { mnId: string }) {
  const [wif, setWif] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await importKey(mnId, wif);
    setBusy(false);
    if (result.ok) setWif('');
    else setError(result.error ?? 'Could not import key.');
  };

  return (
    <div className="key-field">
      <input
        type="password"
        placeholder="Voting key (WIF)"
        value={wif}
        autoComplete="new-password"
        onChange={(e) => setWif(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && wif.trim()) void submit();
        }}
      />
      <button
        className="vote-button ghost"
        disabled={!wif.trim() || busy}
        onClick={submit}
      >
        Load key
      </button>
      {error && <p className="mono-label error">{error}</p>}
    </div>
  );
}

export function MnDrawer({
  network,
  onClose,
}: {
  network: Network;
  onClose: () => void;
}) {
  const masternodes = useMasternodes();
  const [label, setLabel] = useState('');
  const [proTxHash, setProTxHash] = useState('');
  const [wif, setWif] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkReport, setBulkReport] = useState<string[] | null>(null);

  const add = async () => {
    setFormError(null);
    const result = await addMasternode({ label, proTxHash, wif });
    if (!result.ok) {
      setFormError(result.error ?? 'Could not add masternode.');
      return;
    }
    if (result.error) setFormError(result.error);
    setLabel('');
    setProTxHash('');
    setWif('');
  };

  const runBulk = async () => {
    const result = await bulkImport(bulkText);
    const report = [
      `Added ${plural(result.added, 'masternode')}, loaded ${plural(result.keysLoaded, 'key')}.`,
      ...result.errors,
    ];
    setBulkReport(report);
    if (result.errors.length === 0) setBulkText('');
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="My masternodes"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-header">
          <h2>My masternodes</h2>
          <button className="link-button" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="drawer-note">
          ProTxHashes and labels are saved in this browser. Voting keys are held
          <strong> in memory only</strong> — they are never stored or sent
          anywhere, and disappear when you close the tab. Signing happens
          locally.
        </p>

        {masternodes.length === 0 ? (
          <p className="page-note">
            Add a masternode to vote. You need its ProTxHash and the private key
            for its registered voting address.
          </p>
        ) : (
          <ul className="mn-list">
            {masternodes.map((mn) => (
              <li key={mn.id} className="mn-row">
                <div className="mn-row-head">
                  <span className="mn-pick-label">{mn.label}</span>
                  <span className="mono-label" title={mn.proTxHash}>
                    {shortId(mn.proTxHash, 8)}
                  </span>
                  <button
                    className="link-button danger"
                    onClick={() => removeMasternode(mn.id)}
                  >
                    Remove
                  </button>
                </div>
                {mn.hasKey ? (
                  <div className="mn-key-state">
                    <span className="chip won">key loaded</span>
                    <span className="mono-label" title="Derived from the imported key — check it matches this masternode's registered voting address (protx info)">
                      votes as {mn.votingAddress}
                    </span>
                    <button className="link-button" onClick={() => forgetKey(mn.id)}>
                      Forget key
                    </button>
                  </div>
                ) : (
                  <KeyField mnId={mn.id} />
                )}
              </li>
            ))}
          </ul>
        )}

        <section className="drawer-section">
          <h3>Add a masternode</h3>
          <input
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            placeholder="ProTxHash (64 hex characters)"
            className="mono"
            value={proTxHash}
            onChange={(e) => setProTxHash(e.target.value)}
          />
          <input
            type="password"
            placeholder="Voting key WIF (optional, add later)"
            autoComplete="new-password"
            value={wif}
            onChange={(e) => setWif(e.target.value)}
          />
          {formError && <p className="mono-label error">{formError}</p>}
          <button
            className="vote-button"
            disabled={!proTxHash.trim()}
            onClick={add}
          >
            Add masternode
          </button>
        </section>

        <details className="drawer-section">
          <summary>Bulk import</summary>
          <p className="drawer-note">
            One masternode per line: <code>proTxHash,votingKeyWIF,label</code>{' '}
            — WIF and label are optional. Lines starting with # are ignored.
            Useful when several masternodes share one voting key.
          </p>
          <textarea
            rows={5}
            className="mono"
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={'# proTxHash,WIF,label\nabc123…,Xk3…,alpha'}
          />
          <button
            className="vote-button"
            disabled={!bulkText.trim()}
            onClick={runBulk}
          >
            Import
          </button>
          {bulkReport && (
            <ul className="bulk-report">
              {bulkReport.map((line, i) => (
                <li key={i} className={i === 0 ? 'mono-label' : 'mono-label error'}>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </details>

        <p className="fine-print">
          The key must be the one for the masternode's registered{' '}
          <code>votingAddress</code> — not the owner, operator, or collateral
          key. Verify with <code>protx info &lt;proTxHash&gt;</code> in Dash
          Core on {network}.
        </p>
      </aside>
    </div>
  );
}
