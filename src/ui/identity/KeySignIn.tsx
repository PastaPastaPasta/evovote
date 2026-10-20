import { useState } from 'react';
import type { Network } from '../../sdk/network';
import { signIn } from '../../identity/session';
import { shortId } from '../format';

/**
 * Sign in by pasting a private key. The input is cleared after every try and
 * never autocompleted; the key stays in memory for this tab only.
 */
export function KeySignIn({ network, onSignedIn }: { network: Network; onSignedIn?: () => void }) {
  const [wif, setWif] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ wif: string; ids: string[] } | null>(null);

  const submit = async (key: string, chosenId?: string) => {
    setBusy(true);
    setError(null);
    const result = await signIn(network, key, chosenId);
    setBusy(false);
    setWif('');
    if (result.ok) {
      setChoices(null);
      onSignedIn?.();
    } else if ('choose' in result) {
      setChoices({ wif: key, ids: result.choose });
    } else {
      setChoices(null);
      setError(result.error);
    }
  };

  return (
    <div className="signin">
      <label className="field">
        <span className="mono-label">Private key (WIF) of a HIGH or CRITICAL authentication key</span>
        <div className="key-field">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={network === 'testnet' ? 'c… (testnet WIF)' : 'X… (mainnet WIF)'}
            value={wif}
            onChange={(e) => {
              setWif(e.target.value);
              // A new key replaces the one waiting for an identity choice.
              setChoices(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && wif.trim() && !busy) void submit(wif);
            }}
          />
          <button className="vote-button" disabled={!wif.trim() || busy} onClick={() => void submit(wif)}>
            {busy ? 'Looking up…' : 'Sign in'}
          </button>
        </div>
      </label>
      <ul className="signin-facts">
        <li>
          <strong>Which key:</strong> one of your identity’s <em>authentication</em> keys at HIGH or CRITICAL
          level. Encryption, decryption, transfer and voting keys cannot sign.
        </li>
        <li>
          <strong>Why:</strong> it signs your comments and moderation-charter filings in this browser.
        </li>
        <li>
          <strong>Where it goes:</strong> nowhere. It stays in this tab’s memory; reloading the page signs you out.
        </li>
        <li>
          <strong>Never your master key here.</strong> EvoVote asks for the master key in one place only, to add a
          charter encryption or decryption key to your identity, and drops it right after.
        </li>
      </ul>
      {error && (
        <p className="page-note error" role="alert">
          {error}
        </p>
      )}
      {choices && (
        <div className="choose-identity">
          <p>Several identities share this key. Which one is yours?</p>
          <button className="link-button" onClick={() => setChoices(null)}>
            Cancel
          </button>
          {choices.ids.map((id) => (
            <button key={id} className="vote-button ghost mono" disabled={busy} onClick={() => void submit(choices.wif, id)}>
              {shortId(id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
