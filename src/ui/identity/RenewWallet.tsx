import { useState } from 'react';
import type { IdentitySession } from '../../identity/session';
import type { Network } from '../../sdk/network';
import { WalletSignIn } from './WalletSignIn';

/** The renewal card on `#/me` when the wallet's key runs low or out: a new code only on request. */
export function RenewWallet({ network, session }: { network: Network; session: IdentitySession }) {
  const [open, setOpen] = useState(false);
  const wallet = session.wallet;
  if (!wallet || wallet.health === 'ok') return null;
  const required = wallet.health === 'renew-required';
  return (
    <section className="signin-card wallet-card">
      <h2>{required ? 'Renew your Dash Wallet sign-in' : 'Your Dash Wallet sign-in runs out soon'}</h2>
      <p className="signin-lede">
        {required
          ? 'The key Dash Wallet gave this browser has expired or used up its allowance, so it cannot post comments.'
          : wallet.renewSoon === 'expiry'
            ? 'The key Dash Wallet gave this browser expires within two weeks.'
            : 'The key Dash Wallet gave this browser has used most of its allowance.'}{' '}
        Approving EvoVote again in Dash Wallet replaces it with a fresh key.
      </p>
      {open ? (
        <WalletSignIn network={network} identityHint={session.identityId} onSignedIn={() => setOpen(false)} />
      ) : (
        <button className={required ? 'vote-button' : 'vote-button ghost'} onClick={() => setOpen(true)}>
          Renew with Dash Wallet
        </button>
      )}
    </section>
  );
}
