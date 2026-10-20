import { walletSessions } from '../../appconnect/runtime';
import { dismissSignOutNotice, useSessionRestoring, useSignOutNotice } from '../../identity/session';
import type { Network } from '../../sdk/network';
import { KeySignIn } from './KeySignIn';
import { returnAfterSignIn } from './returnTo';
import { WALLET_GRANT_TEXT, WalletSignIn } from './WalletSignIn';

const WALLET_REQUIREMENT =
  'Needs a Dash Wallet build with App Connect: today that is the DashPay iOS test build. It covers comments; filing a moderation charter also needs a private key.';

function SignOutNotice() {
  const notice = useSignOutNotice();
  if (!notice) return null;
  return (
    <div className="page-note ok signin-notice" role="status">
      {notice === 'wallet-revoked'
        ? 'Dash Wallet revoked the key it gave this browser, so you are signed out here.'
        : 'Signed out. The key Dash Wallet added stays on your identity until you revoke it in Dash Wallet; signing in again from this browser replaces it.'}{' '}
      <button className="link-button" onClick={dismissSignOutNotice}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * Every place sign-in is offered.
 *
 * - `page` (`#/me`): "Sign in with Dash Wallet" (QR code, started at once),
 *   and below it "Use a private key instead".
 * - `embedded` (a charter page): a button to the wallet sign-in on `#/me`
 *   (which comes back here afterwards) and the private-key form in place.
 *
 * Without wallet sign-in on this build (or network), the private key is the
 * only way in and is shown open.
 */
export function SignInPanel({ network, mode = 'embedded' }: { network: Network; mode?: 'page' | 'embedded' }) {
  const restoring = useSessionRestoring();
  const walletAvailable = walletSessions(network) !== null;

  if (mode === 'embedded') {
    return (
      <div className="signin-embedded">
        {walletAvailable && (
          <div className="signin-embedded-wallet">
            <a className="vote-button" href="#/me">
              Sign in with Dash Wallet
            </a>
            <span className="wallet-note">{WALLET_REQUIREMENT}</span>
          </div>
        )}
        <details className="signin-key" open={!walletAvailable}>
          <summary>{walletAvailable ? 'Use a private key instead' : 'Sign in with a private key'}</summary>
          <KeySignIn network={network} />
        </details>
      </div>
    );
  }

  return (
    <div className="signin-options">
      <SignOutNotice />
      {walletAvailable && (
        <section className="signin-card wallet-card" aria-labelledby="wallet-signin-title">
          <h2 id="wallet-signin-title">Sign in with Dash Wallet</h2>
          <p className="signin-lede">Scan the code with Dash Wallet and approve EvoVote. Nothing to copy or paste.</p>
          {restoring ? (
            <div className="wallet-state" role="status">
              <p className="wallet-state-title">Restoring your Dash Wallet sign-in…</p>
            </div>
          ) : (
            <WalletSignIn network={network} onSignedIn={() => returnAfterSignIn()} />
          )}
          <p className="wallet-note">{WALLET_GRANT_TEXT}</p>
          <p className="wallet-note">{WALLET_REQUIREMENT}</p>
        </section>
      )}
      <details className="signin-card signin-key" open={!walletAvailable}>
        <summary>
          <span className="signin-key-title">{walletAvailable ? 'Use a private key instead' : 'Sign in with a private key'}</span>
          <span className="signin-key-sub">
            {walletAvailable
              ? 'For any wallet, and for filing moderation charters.'
              : 'Paste one of your identity’s HIGH or CRITICAL authentication keys.'}
          </span>
        </summary>
        <KeySignIn network={network} onSignedIn={() => returnAfterSignIn()} />
      </details>
    </div>
  );
}
