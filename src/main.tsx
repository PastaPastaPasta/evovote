import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { handleWalletReturn } from './appconnect/callback';
import { restoreWalletSession } from './identity/session';
import { currentNetwork } from './sdk/network';
import { App } from './ui/App';
import { installReturnTracking } from './ui/identity/returnTo';
import './styles.css';

// Before the first render: a Dash Wallet return link (`?ac_r=…&ac=…`) becomes
// `#/me`, and a wallet sign-in from an earlier visit is restored.
handleWalletReturn();
installReturnTracking();
void restoreWalletSession(currentNetwork());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
