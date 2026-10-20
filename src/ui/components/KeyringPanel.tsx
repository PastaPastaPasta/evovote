import { useRef, useState } from 'react';
import type { Network } from '../../sdk/network';
import {
  addMasternode,
  bulkImport,
  forgetKey,
  importKey,
  removeMasternode,
  useMasternodes,
} from '../../voting/keyring';
import { plural, shortId } from '../format';
import { useDialogFocus } from '../useDialogFocus';

function KeyField({ mnId }: { mnId: string }) {
  const [wif, setWif] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await importKey(mnId, wif);
    setBusy(false);
    // The input is cleared either way: a WIF never lingers in the DOM.
    setWif('');
    if (!result.ok) setError(result.error ?? 'Could not import key.');
  };

  return (
    <div className="key-field">
      <input
        type="password"
        placeholder="Voting key (WIF)"
        aria-label="Voting key (WIF)"
        value={wif}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setWif(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && wif.trim() && !busy) void submit();
        }}
      />
      <button className="vote-button ghost" disabled={!wif.trim() || busy} onClick={submit}>
        {busy ? 'Checking…' : 'Load key'}
      </button>
      {error && <p className="mono-label error">{error}</p>}
    </div>
  );
}

/**
 * The masternode keyring: add nodes, load voting keys (memory only), bulk
 * import. Rendered in the drawer and on the `#/mn` page.
 */
export function KeyringPanel({ network }: { network: Network }) {
  const masternodes = useMasternodes();
  const [label, setLabel] = useState('');
  const [proTxHash, setProTxHash] = useState('');
  const [wif, setWif] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkReport, setBulkReport] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setFormError(null);
    setBusy(true);
    const result = await addMasternode({ label, proTxHash, wif });
    setBusy(false);
    setWif('');
    if (!result.ok) {
      setFormError(result.error ?? 'Could not add masternode.');
      return;
    }
    if (result.error) setFormError(result.error);
    setLabel('');
    setProTxHash('');
  };

  const runBulk = async () => {
    setBusy(true);
    const result = await bulkImport(bulkText);
    setBusy(false);
    setBulkReport([
      `Added ${plural(result.added, 'masternode')}, loaded ${plural(result.keysLoaded, 'key')}.`,
      ...result.errors,
    ]);
    // Bulk text may hold WIFs: never leave it in the textarea.
    setBulkText('');
  };

  return (
    <>
      <p className="drawer-note">
        ProTxHashes and labels are saved in this browser. Voting keys are held
        <strong> in memory only</strong>: never stored or sent anywhere, and gone when you
        close the tab. Each key is checked against the masternode's voter identity on
        Platform before it is accepted. Signing happens locally.
      </p>

      {masternodes.length === 0 ? (
        <p className="page-note">
          Add a masternode to vote. You need its ProTxHash and the private key for its
          registered voting address.
        </p>
      ) : (
        <ul className="mn-list">
          {masternodes.map((mn) => (
            <li key={mn.id} className="mn-row">
              <div className="mn-row-head">
                <span className="mn-pick-label">{mn.label}</span>
                <span className="mono-label mono" title={mn.proTxHash}>
                  {shortId(mn.proTxHash)}
                </span>
                <button className="link-button danger" onClick={() => removeMasternode(mn.id)}>
                  Remove
                </button>
              </div>
              {mn.hasKey ? (
                <div className="mn-key-state">
                  <span className="chip won">key verified</span>
                  <span
                    className="mono-label"
                    title="Derived from the imported key: check it matches this masternode's registered voting address (protx info)"
                  >
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
          aria-label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          placeholder="ProTxHash (64 hex characters)"
          aria-label="ProTxHash"
          className="mono"
          value={proTxHash}
          spellCheck={false}
          onChange={(e) => setProTxHash(e.target.value)}
        />
        <input
          type="password"
          placeholder="Voting key WIF (optional, add later)"
          aria-label="Voting key WIF"
          autoComplete="off"
          spellCheck={false}
          value={wif}
          onChange={(e) => setWif(e.target.value)}
        />
        {formError && <p className="mono-label error">{formError}</p>}
        <button className="vote-button" disabled={!proTxHash.trim() || busy} onClick={add}>
          Add masternode
        </button>
      </section>

      <details className="drawer-section">
        <summary>Bulk import</summary>
        <p className="drawer-note">
          One masternode per line: <code>proTxHash,votingKeyWIF,label</code>. WIF and label
          are optional; lines starting with # are ignored. Useful when several masternodes
          share one voting key.
        </p>
        <textarea
          rows={5}
          className="mono"
          aria-label="Bulk import lines"
          autoComplete="off"
          spellCheck={false}
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          placeholder={'# proTxHash,WIF,label\nabc123…,cN3…,alpha'}
        />
        <button className="vote-button" disabled={!bulkText.trim() || busy} onClick={runBulk}>
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
        The key must be the one for the masternode's registered <code>votingAddress</code>,
        not the owner, operator or collateral key. Verify with{' '}
        <code>protx info &lt;proTxHash&gt;</code> in Dash Core on {network}.
      </p>
    </>
  );
}

/** The keyring as a slide-in drawer (header button, vote modal). */
export function MnDrawer({ network, onClose }: { network: Network; onClose: () => void }) {
  const drawerRef = useRef<HTMLElement>(null);
  useDialogFocus(drawerRef, onClose);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Vote with a masternode"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-header">
          <h2>Vote with a masternode</h2>
          <button className="icon-button drawer-close" onClick={onClose} aria-label="Close" data-autofocus>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <KeyringPanel network={network} />
      </aside>
    </div>
  );
}
