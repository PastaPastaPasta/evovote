import { useEffect, useRef, useState } from 'react';
import { loginWithKey, walletSession, type DiscussionSession } from '../lib/discussion-auth';
import { checkWalletLogin, walletLoginRequest } from '../lib/wallet';
import { errorMessage, type Network, type SdkHandle } from '../lib/sdk';
import { shortId } from '../lib/format';
import { WalletRequest } from './WalletRequest';

export function DiscussionLogin({ handle, network, contractId, exchangeId, onLogin }: {
  handle: SdkHandle; network: Network; contractId: string; exchangeId: string;
  onLogin: (session: DiscussionSession) => void;
}) {
  const [request, setRequest] = useState<ReturnType<typeof walletLoginRequest>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [candidates, setCandidates] = useState<DiscussionSession[]>([]);
  const ownedKey = useRef<DiscussionSession['privateKey']>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ownedKey.current?.free(); };
  }, []);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      try {
        if (Date.now() > deadline) throw new Error('Wallet login expired. Connect again to create a fresh request.');
        const id = await checkWalletLogin(handle, exchangeId, contractId, request);
        if (cancelled) return;
        if (id) {
          const session = await walletSession(handle, id);
          if (!cancelled) onLogin(session);
          return;
        }
        timer = setTimeout(() => { void poll(); }, 3000);
      } catch (e) {
        if (!cancelled) { setError(errorMessage(e)); setRequest(undefined); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); request.secret.fill(0); };
  }, [handle, exchangeId, contractId, request, onLogin]);

  async function submitKey(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    const input = keyInput;
    setKeyInput('');
    try {
      const found = await loginWithKey(handle, network, input);
      if (!alive.current) { found[0]?.privateKey?.free(); return; }
      if (found.length === 1) onLogin(found[0]);
      else { ownedKey.current = found[0].privateKey; setCandidates(found); }
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }

  return (
    <div className="discussion-login">
      <p>Join the conversation with your Dash Platform identity.</p>
      {!request && !candidates.length && <button className="vote-button" disabled={!exchangeId || busy}
        onClick={() => { setError(''); setRequest(walletLoginRequest(contractId, network)); }}>
        Connect wallet
      </button>}
      {!exchangeId && <p className="fine-print">Wallet login is not configured on {network} yet.</p>}
      {request && <>
        <WalletRequest uri={request.uri} title="Connect your Dash wallet" />
        <p className="fine-print">Scan with a compatible wallet. Each comment will ask for approval separately.</p>
        <button className="link-button" onClick={() => setRequest(undefined)}>Cancel connection</button>
      </>}
      {!request && !candidates.length && <details className="key-login">
        <summary>Use an authentication key instead</summary>
        <form onSubmit={event => { void submitKey(event); }}>
          <label htmlFor="discussion-key">Authentication private key</label>
          <input id="discussion-key" type="password" autoComplete="off" spellCheck={false}
            value={keyInput} onChange={event => setKeyInput(event.target.value)} placeholder="Hex or WIF" disabled={busy} />
          <p className="fine-print">Your identity is found automatically. The key stays in this tab’s memory until you sign out or leave this page.</p>
          <button className="vote-button ghost" disabled={busy || !keyInput.trim()}>{busy ? 'Finding identity…' : 'Sign in'}</button>
        </form>
      </details>}
      {candidates.length > 0 && <div>
        <p>This key belongs to multiple identities. Choose which one to use:</p>
        {candidates.map(session => <button key={session.identityId} className="vote-button ghost"
          title={session.identityId} onClick={() => { ownedKey.current = undefined; onLogin(session); }}>
          {shortId(session.identityId, 10)}
        </button>)}
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
