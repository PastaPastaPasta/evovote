import { useEffect, useRef, useState } from 'react';
import { errorMessage, loadSdk, type Network } from '../lib/sdk';
import { prepareWalletVote, walletVoteMatches, type PreparedVote } from '../lib/wallet-vote';
import { stateTransitionUri } from '../lib/wallet';
import { useMasternodes } from '../lib/mn';
import type { VoteChoice } from '../lib/vote';
import { WalletRequest } from './WalletRequest';

export function WalletVote({ network, label, choice }: { network: Network; label: string; choice: VoteChoice }) {
  const masternodes = useMasternodes();
  const [proTxHash, setProTxHash] = useState(masternodes[0]?.proTxHash ?? '');
  const [address, setAddress] = useState(masternodes[0]?.votingAddress ?? '');
  const [prepared, setPrepared] = useState<PreparedVote>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function prepare(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setVerified(false);
    try {
      const request = await prepareWalletVote(await loadSdk(network), network, proTxHash.trim(), address.trim(), label, choice);
      if (alive.current) setPrepared(request);
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function check() {
    if (!prepared) return;
    setBusy(true); setError('');
    try {
      const matches = await walletVoteMatches(await loadSdk(network), prepared);
      if (alive.current) {
        setVerified(matches);
        if (!matches) setError('Your requested vote is not confirmed yet. Approve it in your wallet, then check again.');
      }
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }

  return <div className="wallet-vote">
    <p className="modal-hint">Approve one masternode vote in your wallet. Enter the public ProTxHash and voting address from <code>protx info</code>. Your voting key stays in the wallet.</p>
    {!prepared ? <form onSubmit={event => { void prepare(event); }}>
      {masternodes.length > 0 && <label>Saved masternode<select value={proTxHash} disabled={busy} onChange={event => {
        setProTxHash(event.target.value); setAddress(masternodes.find(mn => mn.proTxHash === event.target.value)?.votingAddress ?? '');
      }}><option value="">Choose a masternode</option>{masternodes.map(mn => <option key={mn.id} value={mn.proTxHash}>{mn.label}</option>)}</select></label>}
      <label>ProTxHash<input value={proTxHash} onChange={event => setProTxHash(event.target.value)} disabled={busy} spellCheck={false} /></label>
      <label>Voting address<input value={address} onChange={event => setAddress(event.target.value)} disabled={busy} spellCheck={false} /></label>
      <button className="vote-button" disabled={busy || !proTxHash.trim() || !address.trim()}>{busy ? 'Preparing vote…' : 'Prepare wallet vote'}</button>
    </form> : <>
      {!verified && <WalletRequest uri={stateTransitionUri(prepared.bytes, network)} title="Approve this vote in your wallet" />}
      {verified ? <p role="status">Your current vote on Platform matches this choice.</p>
        : <button className="vote-button" disabled={busy} onClick={() => { void check(); }}>{busy ? 'Checking…' : 'Check vote on Platform'}</button>}
      <p className="fine-print">The wallet must support masternode vote requests. Each masternode has up to 5 votes per contest.</p>
      <button className="link-button" disabled={busy} onClick={() => { setPrepared(undefined); setVerified(false); setError(''); }}>Prepare another vote</button>
      <p className="fine-print">Preparing another vote does not revoke a request already shared with your wallet.</p>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
