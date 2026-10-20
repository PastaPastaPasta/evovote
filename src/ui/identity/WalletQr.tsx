import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

/**
 * The sign-in request as a QR code, an "Open in Dash Wallet" link (a wallet
 * on this device handles `dash-key:` links) and a copy fallback. Browsers say
 * nothing when no app handles the link, so a hint appears once it was tapped.
 * No countdown: the request's lifetime is a polling budget, and the panel
 * shows its own "check again" when it runs out. (From Yappr's
 * components/auth/key-exchange-qr.tsx.)
 */
export function WalletQr({ uri }: { uri: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [launched, setLaunched] = useState(false);
  const [touch] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches);
  const [shownUri, setShownUri] = useState(uri);
  // A new request starts a fresh attempt.
  if (shownUri !== uri) {
    setShownUri(uri);
    setLaunched(false);
  }

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    (navigator.clipboard?.writeText(uri) ?? Promise.reject(new Error('no clipboard'))).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
  };

  return (
    <div className="wallet-qr">
      <div className="wallet-qr-code">
        <QRCodeSVG
          value={uri}
          title="Sign-in request: scan with Dash Wallet"
          size={208}
          level="M"
          marginSize={0}
          fgColor="#000000"
          bgColor="#ffffff"
        />
      </div>
      <div className="wallet-qr-actions">
        <a className="vote-button wallet-open" href={uri} onClick={() => setLaunched(true)}>
          Open in Dash Wallet
        </a>
        <button type="button" className="link-button" onClick={copy}>
          {copied === 'copied' ? 'Link copied' : copied === 'failed' ? 'Could not copy' : 'Copy sign-in link'}
        </button>
      </div>
      <p className="wallet-qr-hint">
        {touch
          ? 'Tap “Open in Dash Wallet” if the wallet is on this phone, or scan the code with a wallet on another device.'
          : 'Scan the code with Dash Wallet on your phone.'}
      </p>
      {launched && (
        <p className="wallet-qr-hint">
          Nothing opened? No app on this device handles Dash sign-in links. Scan the code with a phone that has
          Dash Wallet instead.
        </p>
      )}
    </div>
  );
}
