import { useState } from 'react';
import { addStepKey } from '../../identity/session';

/**
 * While signed in with Dash Wallet: load a HIGH or CRITICAL authentication
 * key of the same identity for a step the wallet's key cannot sign (charter
 * filings). The wallet sign-in stays; the key lives in this tab's memory.
 */
export function AddStepKey({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const [wif, setWif] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    const result = await addStepKey(wif);
    setBusy(false);
    setWif('');
    if (!result.ok) setError(result.error);
  };

  return (
    <div className="step-key" role="group" aria-label="Add a key for this step">
      <p className="step-key-message">{message}</p>
      {!open ? (
        <button className="vote-button ghost" onClick={() => setOpen(true)}>
          Add a key for this step
        </button>
      ) : (
        <>
          <div className="key-field">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Private key (WIF) of a HIGH or CRITICAL authentication key"
              placeholder="Private key (WIF) of a HIGH or CRITICAL authentication key"
              value={wif}
              onChange={(e) => setWif(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && wif.trim() && !busy) void load();
              }}
            />
            <button className="vote-button" disabled={!wif.trim() || busy} onClick={() => void load()}>
              {busy ? 'Checking…' : 'Load key'}
            </button>
          </div>
          <p className="wallet-note">
            One of your identity’s authentication keys at HIGH or CRITICAL level, not the master key. It stays in
            this tab’s memory; you stay signed in with Dash Wallet.
          </p>
        </>
      )}
      {error && (
        <p className="page-note error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
