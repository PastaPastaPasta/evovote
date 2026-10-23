import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SignInPrompt } from '../discussion/SignInPrompt';
import { SignInPanel, signOutNoticeText } from './SignInPanel';
import { SigningProblemNote } from './SigningProblemNote';
import { AddStepKey } from './AddStepKey';
import { KeySourceToggle, RecoveryPhraseField } from './RecoveryPhraseField';
import { WALLET_CHARTERS_MESSAGE } from '../../identity/session';

vi.stubEnv('VITE_DISCUSSION_TESTNET_CONTRACT_ID', '2iaUXM8bZb6paYW1mRWCEUMe8EU1tp4Tbg456PXPN3qt');

describe('sign-in rendering', () => {
  it('offers Dash Wallet first and a private key below it on a charter page', () => {
    const html = renderToStaticMarkup(<SignInPanel network="testnet" />);
    expect(html).toContain('href="#/me">Sign in with Dash Wallet</a>');
    expect(html).toContain('<summary>Use a private key instead</summary>');
    expect(html.indexOf('Sign in with Dash Wallet')).toBeLessThan(html.indexOf('Use a private key instead'));
    // The key form is there but closed.
    expect(html).toMatch(/<details class="signin-key">/);
  });

  it('opens the private key when wallet sign-in is not available on the network', () => {
    const html = renderToStaticMarkup(<SignInPanel network="mainnet" />);
    expect(html).not.toContain('Sign in with Dash Wallet');
    expect(html).toContain('<details class="signin-key" open="">');
    expect(html).toContain('Sign in with a private key');
  });

  it('says plainly which key the private-key form wants', () => {
    const html = renderToStaticMarkup(<SignInPanel network="testnet" mode="page" />);
    expect(html).toContain('HIGH or CRITICAL authentication key');
    expect(html).toContain('Never your master key here.');
    expect(html).not.toContain('master key is never asked');
  });

  it('tells a sign-out in another tab apart from a revoke, and a failed key delete from a clean sign-out', () => {
    expect(signOutNoticeText('wallet-signed-out-elsewhere')).toContain('another EvoVote tab');
    expect(signOutNoticeText('wallet-signed-out-elsewhere')).not.toContain('removed');
    expect(signOutNoticeText('wallet-revoked')).toContain('Dash Wallet removed the key');
    expect(signOutNoticeText('wallet-forget-failed')).toContain('could not delete');
  });

  it('points a signed-out reader at sign-in from the discussion', () => {
    expect(renderToStaticMarkup(<SignInPrompt />)).toContain('href="#/me">Sign in</a>');
  });

  it('explains a signing problem with the way forward', () => {
    const renew = renderToStaticMarkup(<SigningProblemNote problem={{ reason: 'renew', message: 'Renew it.' }} />);
    expect(renew).toContain('Renew it.');
    expect(renew).toContain('Renew on my identity page');
    const out = renderToStaticMarkup(<SigningProblemNote problem={{ reason: 'signed-out', message: 'Sign in first.' }} />);
    expect(out).toContain('href="#/me">Sign in</a>');
  });
});

describe('recovery phrase entry', () => {
  it('offers a phrase or a key for a step Dash Wallet cannot sign', () => {
    const html = renderToStaticMarkup(<AddStepKey message={WALLET_CHARTERS_MESSAGE} />);
    expect(html).toContain('Enter your recovery phrase or a HIGH/CRITICAL key to continue; it stays in this tab only.');
    expect(html).toContain('Continue with a phrase or key');
  });

  it('lets the user pick a phrase or a WIF', () => {
    const html = renderToStaticMarkup(<KeySourceToggle value="phrase" onChange={() => undefined} />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Recovery phrase</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Private key \(WIF\)</);
  });

  it('masks the phrase with CSS, not as a password a browser would offer to save, and warns plainly on testnet', () => {
    vi.stubGlobal('CSS', { supports: (property: string) => property === '-webkit-text-security' });
    const html = renderToStaticMarkup(<RecoveryPhraseField network="testnet" submitLabel="Use phrase" onSubmit={async () => undefined} />);
    vi.unstubAllGlobals();
    expect(html).toContain('type="text"');
    expect(html).toContain('class="phrase-input"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-1p-ignore');
    expect(html).toContain('Your recovery phrase controls your whole wallet. Only enter it on testnet sites you trust.');
    // Without CSS masking (no CSS global here), a password field is the fallback.
    const mainnet = renderToStaticMarkup(<RecoveryPhraseField network="mainnet" submitLabel="Use phrase" onSubmit={async () => undefined} />);
    expect(mainnet).toContain('type="password"');
    expect(mainnet).not.toContain('testnet');
    expect(mainnet).toContain('Only enter it on sites you trust.');
  });

  it('takes no phrase while disabled (the update it was for is signing or done)', () => {
    const html = renderToStaticMarkup(
      <RecoveryPhraseField network="testnet" submitLabel="Find master key" onSubmit={async () => undefined} disabled />,
    );
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});
