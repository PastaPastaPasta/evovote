import { useState } from 'react';
import type { Network } from '../../sdk/network';
import { signIn } from '../../identity/session';
import { shortId } from '../format';

/**
 * Paste a private key to sign in. The input is cleared after every try and
 * never autocompleted; the key stays in memory for this tab only.
 */
export function SignInPanel({ network }: { network: Network }) {
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
        <span className="mono-label">Private key (WIF) of one of your identity&apos;s keys</span>
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
      <p className="fine-print">
        Use a HIGH or CRITICAL authentication key. The key stays in this tab&apos;s memory and is never stored
        or sent anywhere; reloading the page signs you out. Your master key is never asked for here.
      </p>
      {error && <p className="mono-label error">{error}</p>}
      {choices && (
        <div className="choose-identity">
          <p>Several identities share this key. Which one is yours?</p>
          <button className="link-button" onClick={() => setChoices(null)}>
            Cancel
          </button>
          {choices.ids.map((id) => (
            <button key={id} className="vote-button ghost mono" disabled={busy} onClick={() => void submit(choices.wif, id)}>
              {shortId(id, 8)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
