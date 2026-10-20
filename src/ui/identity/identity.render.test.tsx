import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SignInPrompt } from '../discussion/SignInPrompt';
import { SignInPanel, signOutNoticeText } from './SignInPanel';
import { SigningProblemNote } from './SigningProblemNote';

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
