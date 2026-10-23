import { useState } from 'react';
import { addStepKey, addStepKeyFromPhrase, useIdentitySession } from '../../identity/session';
import { attempts } from '../attempts';
import { KeySourceToggle, RecoveryPhraseField, type KeySource } from './RecoveryPhraseField';

/**
 * While signed in with Dash Wallet: load a HIGH or CRITICAL authentication
 * key of the same identity for a step the wallet's key cannot sign (charter
 * filings), pasted as a WIF or derived from the recovery phrase. The wallet
 * sign-in stays; the key lives in this tab's memory, and a phrase is not kept.
 */
export function AddStepKey({ message }: { message: string }) {
  const session = useIdentitySession();
  const [open, setOpen] = useState(false);
  // The phrase first on testnet (Dash Wallet users have no WIF); the WIF first on mainnet.
  const [source, setSource] = useState<KeySource>(session?.network === 'mainnet' ? 'wif' : 'phrase');
  const [wif, setWif] = useState('');
  const [busy, setBusy] = useState(false);
  const [phraseBusy, setPhraseBusy] = useState(false);
  const [phraseAttempts] = useState(attempts);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    const result = await addStepKey(wif);
    setBusy(false);
    setWif('');
    if (!result.ok) setError(result.error);
  };

  const loadPhrase = async (phrase: string) => {
    setError(null);
    const current = phraseAttempts.start();
    const result = await addStepKeyFromPhrase(phrase);
    if (!result.ok && current()) setError(result.error);
  };

  return (
    <div className="step-key" role="group" aria-label="Add a key for this step">
      <p className="step-key-message">{message}</p>
      {!open ? (
        <button className="vote-button ghost" onClick={() => setOpen(true)}>
          Continue with a phrase or key
        </button>
      ) : (
        <>
          <KeySourceToggle
            value={source}
            disabled={busy || phraseBusy}
            onChange={(next) => {
              phraseAttempts.cancel();
              setSource(next);
              setWif('');
              setError(null);
            }}
          />
          {source === 'phrase' && session ? (
            <>
              <RecoveryPhraseField
                network={session.network}
                submitLabel="Use phrase"
                onSubmit={loadPhrase}
                onBusyChange={setPhraseBusy}
              />
              <p className="wallet-note">
                EvoVote finds your identity’s HIGH or CRITICAL key in the phrase and keeps only that key, in this
                tab’s memory. The phrase itself is not kept. You stay signed in with Dash Wallet.
              </p>
            </>
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
