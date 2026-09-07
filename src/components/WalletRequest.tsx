import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export function WalletRequest({ uri, title }: { uri: string; title: string }) {
  const [copyStatus, setCopyStatus] = useState('Copy request');
  // Larger comments can exceed QR capacity; copy/open remains available.
  return (
    <div className="wallet-request">
      <h3>{title}</h3>
      {uri.length <= 2200 ? (
        <QRCodeSVG value={uri} size={224} level="L" marginSize={4} title={title} />
      ) : <p>This request is too large for a QR code. Open your wallet or copy it.</p>}
      <div className="discussion-actions">
        <a className="vote-button" href={uri}>Open wallet</a>
        <button className="vote-button ghost" type="button" onClick={() => {
          void (navigator.clipboard?.writeText(uri) ?? Promise.reject()).then(
            () => setCopyStatus('Copied'), () => setCopyStatus('Copy the request below'),
          );
        }}>{copyStatus}</button>
      </div>
      <details><summary>Wallet request</summary><textarea aria-label="Wallet request" value={uri} readOnly /></details>
    </div>
  );
}
